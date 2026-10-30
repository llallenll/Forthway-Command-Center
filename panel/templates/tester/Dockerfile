# FCC website tester — Claude Code + a real browser, in a sandbox.
#
# Built once per server by shared/testenv.mjs (image fcc-tester:latest,
# label fcc.tester.hash = hash of this file and fcc-report.mjs; it is rebuilt
# when either changes). It runs with every capability dropped, a read-only
# root filesystem and /tmp as its only writable place besides /out, as the
# unprivileged `tester` user (uid 10001 — the runner relies on that number).
#
# Nothing secret is baked in: the Claude Code token arrives as
# CLAUDE_CODE_OAUTH_TOKEN when the container starts, and the brief is mounted
# at /brief/PROMPT.md for each run.

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Tools the checklist uses: curl/jq for HTTP, a MySQL client to look at what
# the app stored in its throw-away database, dig for DNS, git for the source.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq git dnsutils procps mariadb-client openssl \
 && rm -rf /var/lib/apt/lists/*

# Claude Code, and Playwright with Chromium (plus the system libraries it
# needs) for real browser flows: sign-up, cart, checkout.
RUN npm install -g @anthropic-ai/claude-code playwright \
 && playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY fcc-report.mjs /usr/local/bin/fcc-report
RUN chmod 0755 /usr/local/bin/fcc-report \
 && useradd --create-home --uid 10001 --shell /bin/bash tester

USER 10001:10001
WORKDIR /out
CMD ["sleep", "infinity"]
