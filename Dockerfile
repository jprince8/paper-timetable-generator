FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1
ENV PORT=8080

CMD exec gunicorn -b :$PORT --workers 2 --threads 8 --timeout 120 app:app
