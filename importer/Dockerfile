# One-shot importer: loads the pipeline CSVs into Postgres.
#   docker compose --profile import run --rm importer
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
# diff.py is imported by import.py for --diff; without it the image crashes at startup.
COPY import.py diff.py ./
RUN useradd --system --uid 10001 importer
USER importer
# data/ is bind-mounted read-only at /data by docker-compose; DATABASE_URL comes from .env
ENTRYPOINT ["python3", "/app/import.py"]
CMD ["--voters", "/data/voters_final.csv", "--households", "/data/households.csv", "--label", "voters list import"]
