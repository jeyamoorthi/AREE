"""Policy intelligence console: live index state and document upload.

Upload writes into the engine's POLICY_DIR, which the Pathway DocumentStore
watches in streaming mode — indexing stays entirely in the Python RAG layer.
"""

import os

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from .. import engine
from .. import auth
from ..deps import require_engine
from ..schemas import (
    PolicyFile, PolicyParseError, PolicyResponse, PolicyUploadResponse,
)

router = APIRouter(tags=["policy"])

ALLOWED_EXTENSIONS = {".txt", ".pdf", ".docx"}
MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB


@router.get("/policy", response_model=PolicyResponse,
            summary="Live policy index status and indexed documents")
def policy() -> PolicyResponse:
    require_engine()
    engine.scan_policy_files()
    state = engine.rag_state()

    return PolicyResponse(
        index_type=state.get("index_type"),
        docs_indexed=state.get("docs_indexed", 0),
        chunks_indexed=state.get("chunks_indexed", 0),
        embed_model=state.get("embed_model"),
        last_reindex=state.get("last_reindex"),
        store_status=state.get("store_status"),
        policy_files=[PolicyFile(**f) for f in state.get("policy_files", [])],
        parse_errors=[
            PolicyParseError(**e) for e in state.get("parse_errors", [])
        ],
        error=state.get("error"),
    )


@router.post("/policy/upload", response_model=PolicyUploadResponse, status_code=201,
             summary="Upload a policy document into the live RAG index")
async def upload_policy(
        file: UploadFile = File(...),
        principal: auth.Principal = Depends(auth.requires("policy:write")),
) -> PolicyUploadResponse:
    """
    Accept a policy document into the corpus.

    REQUIRES THE `policy:write` CAPABILITY, WHICH `authority` DOES NOT HOLD.
        The policy corpus is the ground truth an advisory is generated against, so
        writing to it is a change to the evidence base rather than a decision taken
        on it. An administrator curates that corpus; an authority decides against
        it. Neither role can do the other's job, which is why this endpoint and the
        case decision endpoint require different capabilities rather than merely
        "being logged in".

    The upload was previously unauthenticated: anyone who could reach the endpoint
    could introduce a document that later advisories would be grounded on.
    """
    require_engine()
    c = engine.config()

    raw_name = os.path.basename(file.filename or "")
    if not raw_name:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_filename", "detail": "No filename supplied."},
        )

    ext = os.path.splitext(raw_name)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail={
                "error": "unsupported_media_type",
                "detail": f"Unsupported file type '{ext}'.",
                "hint": f"Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
            },
        )

    content = await file.read()
    if not content:
        raise HTTPException(
            status_code=400,
            detail={"error": "empty_file", "detail": "Uploaded file is empty."},
        )
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail={
                "error": "file_too_large",
                "detail": f"File exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
            },
        )

    policy_dir = os.path.abspath(c.POLICY_DIR)
    os.makedirs(policy_dir, exist_ok=True)
    save_path = os.path.abspath(os.path.join(policy_dir, raw_name))

    # Refuse anything that would escape the policy directory.
    if os.path.commonpath([policy_dir, save_path]) != policy_dir:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_path", "detail": "Illegal filename."},
        )

    with open(save_path, "wb") as fh:
        fh.write(content)

    engine.scan_policy_files()
    state = engine.rag_state()

    return PolicyUploadResponse(
        uploaded=raw_name,
        size_bytes=len(content),
        saved_to=os.path.relpath(save_path, os.path.dirname(policy_dir)),
        docs_indexed=state.get("docs_indexed", 0),
        message="Document ingested. The live policy index picks it up on the next stream update.",
    )
