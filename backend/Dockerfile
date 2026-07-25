FROM node:20-slim

# Compilers/interpreters baked into the image itself, no Docker-in-Docker.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    gcc \
    g++ \
    default-jdk \
    && rm -rf /var/lib/apt/lists/*

# Dedicated low-privilege user student code actually runs as (uid/gid 1001,
# matching SANDBOX_UID/SANDBOX_GID defaults in index.js). nologin shell means
# this account can never be used to log in interactively, only to run the
# one-off spawned processes index.js hands it.
RUN groupadd -g 1001 sandbox \
 && useradd -m -u 1001 -g 1001 -s /usr/sbin/nologin sandbox

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Express process itself stays root so it CAN chown temp dirs to `sandbox`
# and spawn as that uid â€” this is container-internal root only, unrelated
# to the "--privileged" host flag Docker/Piston needed. Render doesn't need
# to grant anything special for this to work.
EXPOSE 3000
CMD ["node", "index.js"]
