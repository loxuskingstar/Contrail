# Contrail — image de production
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CONTRAIL_DATA_DIR=/app/data

# Tesseract (OCR local des immatriculations) + données de fuseaux horaires
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tzdata curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static
COPY scripts ./scripts

# Utilisateur non root ; l'UID/GID est ajustable pour correspondre au propriétaire de ./data sur l'hôte
ARG UID=1000
ARG GID=1000
RUN groupadd -g ${GID} contrail && useradd -u ${UID} -g ${GID} -m contrail \
 && mkdir -p /app/data && chown -R contrail:contrail /app
USER contrail

EXPOSE 8000
VOLUME ["/app/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD curl -fsS http://localhost:8000/api/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
