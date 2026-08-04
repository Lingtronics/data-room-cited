FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src src
COPY scripts scripts
COPY services services
COPY semantic semantic
COPY taxonomy taxonomy

EXPOSE 8770
CMD ["python", "-m", "uvicorn", "app:app", "--app-dir", "services/orchestrator", "--host", "0.0.0.0", "--port", "8770"]
