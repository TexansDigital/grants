#!/usr/bin/env bash
#
# Who am I about to talk to?
#
#   npm run whoami
#
# WHY THIS EXISTS. Wrangler resolves an account from whichever credentials it
# finds -- an OAuth login shared across every project on the machine, or a
# CLOUDFLARE_API_TOKEN in the environment. Nothing in `wrangler d1 execute` tells
# you which account answered, so the command that wipes a table looks identical
# whether it lands on this project's preview database or on something else
# entirely. This prints the answer before you act on it.
#
# It is READ-ONLY. It changes nothing and can be run as often as you like.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# Reached by path from outside a checkout, or by `npm run whoami` from the
# wrong place. Say which, rather than failing on a missing file three lines
# later -- "you are not in a project" is the whole answer.
if [ ! -f package.json ] || [ ! -f wrangler.toml ]; then
  printf '\033[33m%s\033[0m\n' "This is not a Steward checkout: $(pwd)"
  echo "Run it from inside the project, or by path:"
  echo "    cd ~/grants && npm run whoami"
  echo "    bash ~/grants/scripts/preflight.sh"
  exit 1
fi

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m  !  %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$1"; }

bold "Project"
echo "  directory   $(pwd)"
echo "  package     $(node -pe "require('./package.json').name + ' ' + require('./package.json').version" 2>/dev/null || echo '(unreadable)')"
echo "  branch      $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(not a git repo)')"
echo "  wrangler    $(npx wrangler --version 2>/dev/null | tail -1)"

# A wrangler.toml from a DIFFERENT project is the failure this catches: you are
# in the right directory but an editor or a shell alias pointed elsewhere.
if grep -q '^name = "steward"' wrangler.toml 2>/dev/null; then
  ok "wrangler.toml is Steward's"
else
  warn "wrangler.toml does not declare name = \"steward\". Wrong directory?"
fi

echo
bold "Cloudflare account"
# CLOUDFLARE_API_TOKEN silently overrides an interactive login, so which one is
# in play decides which account answers -- and only one of them is visible in
# `wrangler whoami`.
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  warn "CLOUDFLARE_API_TOKEN is set in this shell. It OVERRIDES your logged-in"
  warn "account, and this script cannot tell you whose token it is."
fi
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "  CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID}"
fi
WHOAMI="$(npx wrangler whoami 2>&1)"
echo "$WHOAMI" | sed 's/^/  /' | head -20

# The scopes an OAuth token carries are fixed when it is minted. A token from an
# older wrangler predates the D1 and R2 scopes, so it reports a healthy login
# and then fails on the first `d1 migrations apply --remote` or
# `r2 bucket create` -- with a permissions error that reads like the resource
# is missing rather than like the token is.
if echo "$WHOAMI" | grep -q 'Token Permissions'; then
  echo
  for scope in d1 r2; do
    if echo "$WHOAMI" | grep -qE "^\s*-\s*${scope}(:| |$)"; then
      ok "token can reach ${scope}"
    else
      warn "token has NO ${scope} scope. Commands touching ${scope} will fail with a"
      warn "permissions error. Fix: npx wrangler logout && npx wrangler login"
    fi
  done
fi

echo
bold "What the DEFAULT commands would touch"
echo "  (npm run dev, migrate:local, seed:local, and any bare wrangler command)"
node -e '
const fs = require("fs");
const toml = fs.readFileSync("wrangler.toml", "utf8");
// Everything before the first [env.*] header is the default environment.
const lines = toml.split(/\r?\n/);
let end = lines.length;
for (let i = 0; i < lines.length; i += 1) {
  if (/^\s*\[+\s*env\./.test(lines[i])) { end = i; break; }
}
const head = lines.slice(0, end).join("\n");
const grab = (re) => { const m = re.exec(head); return m ? m[1] : "(not set)"; };
console.log("  d1 database    " + grab(/database_name\s*=\s*"([^"]*)"/));
console.log("  d1 id          " + grab(/database_id\s*=\s*"([^"]*)"/));
console.log("  d1 preview id  " + grab(/preview_database_id\s*=\s*"([^"]*)"/));
const buckets = [...head.matchAll(/binding\s*=\s*"([^"]+)"\s*\nbucket_name\s*=\s*"([^"]+)"/g)];
for (const [, binding, name] of buckets) console.log("  r2 " + binding.padEnd(11) + " " + name);
const id = grab(/database_id\s*=\s*"([^"]*)"/);
const pid = grab(/preview_database_id\s*=\s*"([^"]*)"/);
if (id !== pid) {
  console.log("");
  console.log("  ! database_id and preview_database_id DIFFER. --remote and --local");
  console.log("    would reach different databases and one of them is not preview.");
  process.exitCode = 1;
}
' || true

echo
bold "Production"
if grep -q 'FILL_IN_AT_DEPLOY_TIME_DO_NOT_COMMIT' wrangler.toml; then
  ok "production bindings are still placeholders — no production id is committed"
else
  warn "a production binding has a real value in it. See npm run check:config."
fi

echo
bold "Before you run anything destructive"
cat <<'NOTE'
  Local     --local          hits .wrangler/state in this directory. Safe.
  Preview   --remote         hits the preview database named above. Shared.
  Staging   --env staging    hits steward-staging. Holds real past data.
  Prod      --env production Refuses to run until a human fills in the ids.

  There is no flag that makes a mistake here reversible, so the rule is:
  read the database name printed above, out loud, before pressing enter.
NOTE
