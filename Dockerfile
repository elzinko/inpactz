# Service web Tournée PAV : Rust + Tesseract (OCR) + Poppler (PDF)
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release -p tournee-server

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tesseract-ocr tesseract-ocr-fra poppler-utils \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/tournee-server /usr/local/bin/tournee-server
ENV PORT=8080
EXPOSE 8080
CMD ["tournee-server"]
