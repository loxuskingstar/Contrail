"""Schéma SQLite et migrations légères (versionnées via PRAGMA user_version)."""
from __future__ import annotations

from .core import connect, ensure_dirs

SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS spotting (
    id_spotting     INTEGER PRIMARY KEY AUTOINCREMENT,
    registration    TEXT NOT NULL,
    aircraft        TEXT,             -- modèle lisible : "Airbus A320-214"
    aircraft_icao   TEXT,             -- code type OACI : "A320"
    manufacturer    TEXT,
    msn             TEXT,             -- TEXT : certains MSN sont alphanumériques
    owner           TEXT,             -- compagnie / propriétaire
    airline_icao    TEXT,
    livery          TEXT,             -- NULL ou "None" = livrée classique
    livery_category TEXT,             -- retro | alliance | commemorative | logojet | special
    military        INTEGER NOT NULL DEFAULT 0,
    flight_type     TEXT,
    date            TEXT,             -- heure locale de l'aéroport, ISO "YYYY-MM-DDTHH:MM"
    date_utc        TEXT,             -- calculée via le fuseau de l'aéroport
    airport         TEXT,             -- code OACI
    location_id     INTEGER REFERENCES spot_locations(id_location) ON DELETE SET NULL,
    lat             REAL,
    lng             REAL,
    description     TEXT,
    image           TEXT,             -- relatif à data/images/
    thumb           TEXT,             -- relatif à data/thumbs/
    image_w         INTEGER,
    image_h         INTEGER,
    atc_audio       TEXT,             -- relatif à data/audio/
    icao24          TEXT,
    country         TEXT,             -- ISO-3166 alpha-2 déduit du préfixe d'immatriculation
    favorite        INTEGER NOT NULL DEFAULT 0,
    rating          INTEGER,
    camera          TEXT,
    lens            TEXT,
    focal           REAL,
    aperture        REAL,
    iso             INTEGER,
    shutter         TEXT,
    exif_json       TEXT,
    sun_elevation   REAL,
    metar           TEXT,
    metar_json      TEXT,
    taf             TEXT,
    weather_status  TEXT,             -- pending | ok | none | error
    draft_uuid      TEXT UNIQUE,      -- idempotence de la synchro hors-ligne
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spot_reg ON spotting(registration);
CREATE INDEX IF NOT EXISTS idx_spot_date ON spotting(date);
CREATE INDEX IF NOT EXISTS idx_spot_airport ON spotting(airport);
CREATE INDEX IF NOT EXISTS idx_spot_type ON spotting(aircraft_icao);
CREATE INDEX IF NOT EXISTS idx_spot_airline ON spotting(airline_icao);

CREATE TABLE IF NOT EXISTS tags (
    id_tag  INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color   TEXT NOT NULL DEFAULT '#64748b'
);

CREATE TABLE IF NOT EXISTS spotting_tags (
    id_spotting INTEGER NOT NULL REFERENCES spotting(id_spotting) ON DELETE CASCADE,
    id_tag      INTEGER NOT NULL REFERENCES tags(id_tag) ON DELETE CASCADE,
    PRIMARY KEY (id_spotting, id_tag)
);

CREATE TABLE IF NOT EXISTS flights (
    id_flight     INTEGER PRIMARY KEY AUTOINCREMENT,
    date          TEXT NOT NULL,
    dep_icao      TEXT NOT NULL,
    arr_icao      TEXT NOT NULL,
    dep_time      TEXT,
    arr_time      TEXT,
    flight_number TEXT,
    airline       TEXT,
    airline_icao  TEXT,
    registration  TEXT,
    aircraft      TEXT,
    aircraft_icao TEXT,
    seat          TEXT,
    seat_type     TEXT,     -- window | middle | aisle
    cabin_class   TEXT,     -- economy | premium | business | first | crew
    reason        TEXT,     -- leisure | business | crew | other
    duration_min  INTEGER,
    distance_km   REAL,
    notes         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flight_reg ON flights(registration);
CREATE INDEX IF NOT EXISTS idx_flight_date ON flights(date);

CREATE TABLE IF NOT EXISTS spot_locations (
    id_location  INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    airport      TEXT,
    lat          REAL NOT NULL,
    lng          REAL NOT NULL,
    runways      TEXT,
    view_bearing REAL,       -- direction (°) vers laquelle l'objectif est pointé
    best_time    TEXT,       -- résumé calculé à partir de la course du soleil
    access       TEXT,
    notes        TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS achievements (
    code        TEXT PRIMARY KEY,
    criteria    TEXT NOT NULL,
    icon        TEXT NOT NULL,
    category    TEXT NOT NULL,
    target      INTEGER NOT NULL,
    unlocked_at TEXT
);

CREATE TABLE IF NOT EXISTS user_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS aircraft_cache (
    registration TEXT PRIMARY KEY,
    data         TEXT NOT NULL,
    source       TEXT,
    fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS airlines (
    key              TEXT PRIMARY KEY,   -- code OACI, sinon nom normalisé
    icao             TEXT,
    iata             TEXT,
    name             TEXT,
    fleet_source     TEXT,               -- airlabs | manual
    fleet_fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS fleets (
    airline_key  TEXT NOT NULL,
    registration TEXT NOT NULL,
    aircraft     TEXT,
    status       TEXT,
    PRIMARY KEY (airline_key, registration)
);

CREATE TABLE IF NOT EXISTS watchlist (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    registration TEXT NOT NULL UNIQUE,
    icao24       TEXT,
    note         TEXT,
    notify       INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT,
    last_status  TEXT,     -- JSON
    airborne     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT,
    link       TEXT,
    data       TEXT,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
    token      TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,   -- gallery | spot | flight | flights | airframe
    target     TEXT,
    title      TEXT,
    views      INTEGER NOT NULL DEFAULT 0,
    revoked    INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL
);
"""

SCHEMA_V2 = """
ALTER TABLE fleets ADD COLUMN aircraft_icao TEXT;
ALTER TABLE fleets ADD COLUMN icao24 TEXT;
ALTER TABLE fleets ADD COLUMN built TEXT;
ALTER TABLE fleets ADD COLUMN source TEXT;
CREATE TABLE IF NOT EXISTS fleet_exclusions (
    airline_key  TEXT NOT NULL,
    registration TEXT NOT NULL,
    created_at   TEXT,
    PRIMARY KEY (airline_key, registration)
);
"""

SCHEMA_V3 = """
-- Wishlist : fusion de la watchlist et des souhaits (appareil, modèle, compagnie, livrée, événement, aéroport…)
CREATE TABLE IF NOT EXISTS wishes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,                 -- aircraft | type | airline | livery | event | airport | other
    title         TEXT NOT NULL,
    value         TEXT,                          -- immatriculation, code type OACI, clé compagnie, texte de livrée, aéroport
    airline_key   TEXT,                          -- restreint une livrée à une compagnie
    family        INTEGER NOT NULL DEFAULT 0,    -- type : toute la famille (A320 → A319/A320/A321)
    note          TEXT,
    priority      INTEGER NOT NULL DEFAULT 2,    -- 1 faible · 2 normale · 3 prioritaire
    status        TEXT NOT NULL DEFAULT 'open',  -- open | done
    goal_count    INTEGER NOT NULL DEFAULT 1,    -- nombre d'appareils distincts à observer
    progress      INTEGER NOT NULL DEFAULT 0,
    since         TEXT,                          -- ne compte que les spots à partir de cette date (NULL : tout l'historique)
    start_date    TEXT,
    end_date      TEXT,
    place         TEXT,
    airport       TEXT,
    lat           REAL,
    lng           REAL,
    url           TEXT,
    parent_id     INTEGER,                       -- objectif rattaché à un événement
    auto_complete INTEGER NOT NULL DEFAULT 1,
    track         INTEGER NOT NULL DEFAULT 0,    -- appareil : alerte quand il est détecté en vol
    notify        INTEGER NOT NULL DEFAULT 1,
    remind_days   INTEGER NOT NULL DEFAULT 7,
    reminded      INTEGER,
    icao24        TEXT,
    last_seen_at  TEXT,
    last_status   TEXT,
    airborne      INTEGER NOT NULL DEFAULT 0,
    done_at       TEXT,
    done_spot_id  INTEGER,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wish_kind ON wishes(kind, status);
CREATE INDEX IF NOT EXISTS idx_wish_parent ON wishes(parent_id);
INSERT INTO wishes(kind, title, value, note, priority, status, auto_complete, track, notify, icao24, last_seen_at,
                   last_status, airborne, created_at, updated_at)
    SELECT 'aircraft', registration, registration, note, 2, 'open', 0, 1, notify, icao24, last_seen_at,
           last_status, airborne, created_at, created_at FROM watchlist;
"""

SCHEMA_V4 = """
-- Immatriculation d'essai (ex. F-WWCF) portée par un avion pendant ses vols d'essai, avant son immatriculation définitive
ALTER TABLE spotting ADD COLUMN test_registration TEXT;
CREATE INDEX IF NOT EXISTS idx_spot_testreg ON spotting(test_registration);
"""

SCHEMA_V5 = """
-- Empreinte perceptuelle (dHash 64 bits, hexadécimal) de la photo : repère deux fois la même image
ALTER TABLE spotting ADD COLUMN phash TEXT;
"""

MIGRATIONS: list[str] = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5]


def init_db() -> None:
    ensure_dirs()
    conn = connect()
    try:
        version = conn.execute("PRAGMA user_version").fetchone()["user_version"]
        for i, script in enumerate(MIGRATIONS, start=1):
            if version < i:
                conn.executescript(script)
                conn.execute(f"PRAGMA user_version = {i}")
        conn.commit()
    finally:
        conn.close()
