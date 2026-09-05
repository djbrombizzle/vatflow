FROM node:22-slim
WORKDIR /app
COPY shared ./shared
COPY fca-tracker ./fca-tracker
ENV VATFLOW_NAV_BASE=https://vatflow.io/data/nav
ENV VATFLOW_SITE_BASE=https://vatflow.io/
ENV POLL_MS=20000
CMD ["node", "fca-tracker/index.mjs"]
