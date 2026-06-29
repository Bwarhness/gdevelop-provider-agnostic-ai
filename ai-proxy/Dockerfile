FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
EXPOSE 4000
# Provider config comes from environment (PROVIDER_BASE_URL / PROVIDER_API_KEY / PROVIDER_MODEL),
# or live via the config UI at http://localhost:4000/.
# Note: PROVIDER_AUTH_SOURCE=omp-kimi is NOT usable in a container (it needs the host's
# oh-my-pi install). Use a static-key provider (OpenAI, Ollama, vLLM, ...) when containerized.
CMD ["node", "src/server.js"]
