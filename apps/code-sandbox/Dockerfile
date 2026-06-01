FROM python:3.13-slim

WORKDIR /app

# System runtimes: curl (healthcheck), nodejs/npm (JS), r-base (R), golang (Go)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    nodejs npm \
    r-base \
    golang \
    && rm -rf /var/lib/apt/lists/*

# TypeScript runner
RUN npm install -g tsx

RUN pip install --no-cache-dir flask "llm-sandbox[docker]"

# Create socket mount-point directory
RUN mkdir -p /var/run/fredo

# Tool bridge auto-hook — runs before every Python script via sitecustomize
COPY sitecustomize.py /usr/local/lib/python3.13/site-packages/sitecustomize.py

COPY sandbox_service.py .

EXPOSE 8080

CMD ["python3", "sandbox_service.py"]
