"""
Historical backfill: the feature store behind any future forecasting model.

Nothing in here runs on a request path. It is a batch pipeline that builds the
joined hourly dataset the live system has never needed and a model cannot be
trained without:

    openaq_history   ground truth      -> station_readings
    met_history      ERA5 meteorology  -> met_hourly
    fire_history     satellite fires   -> fire_events
    features         computed columns  -> derived_features
    db               schema + upserts

Driven by backfill.py at the repository root. Start with `probe` - the point of
this package is to find out what data actually exists before anyone builds on
the assumption that it does.
"""
