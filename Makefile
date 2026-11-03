.PHONY: dev test docker demo

dev:            ## Lance le serveur de développement sur http://localhost:8000
	uvicorn app.main:app --reload --port 8000

test:           ## Tests de l'API (hors-ligne)
	CONTRAIL_OFFLINE=1 python -m pytest -q

docker:         ## Construit et démarre le conteneur
	docker compose up -d --build

demo:           ## Remplit une instance vide avec des données fictives
	python scripts/seed_demo.py --url http://localhost:8000
