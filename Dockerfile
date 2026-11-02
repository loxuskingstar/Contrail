# Contrail — image de production
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CONTRAIL_DATA_DIR=/app/data \
    PUID=1000 \
    PGID=1000

# Tesseract (OCR local des immatriculations), fuseaux horaires, gosu (abandon des droits root)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tzdata curl gosu \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static
COPY scripts ./scripts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# L'application tourne sous l'utilisateur non root « contrail ». Son UID/GID est aligné au
# démarrage sur PUID/PGID, et l'entrypoint rend le dossier de données accessible avant
# d'abandonner les droits root (cas d'un ./data créé par Docker et appartenant à root).
RUN groupadd -g 1000 contrail && useradd -u 1000 -g 1000 -m -s /usr/sbin/nologin contrail \
 && mkdir -p /app/data && chown -R contrail:contrail /app \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8000
VOLUME ["/app/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD curl -fsS http://localhost:8000/api/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
