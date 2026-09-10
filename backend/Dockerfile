# Counter-Inscriptions backend — Deno (INFRA-281 / ADR-049).
# Deps are vendored under vendor/ and pinned in deno.lock, so the image
# builds and runs fully offline (no registry access, no node_modules).
FROM denoland/deno:2.2.12

WORKDIR /app
COPY . .

# Warm the transpile cache at build time (deps resolve from vendor/).
RUN deno cache --cached-only index.ts

EXPOSE 3001

# The base image's ENTRYPOINT is `deno`; these are its arguments.
CMD ["run", "--cached-only", "--allow-net", "--allow-read", "--allow-env", "index.ts"]
