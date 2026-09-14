#!/usr/bin/env bash
# Idempotent label setup for hermes-agent-notes.
# Creates or updates every label below (gh label create --force updates in place).
# Usage: ./scripts/setup-labels.sh [owner/repo]

set -euo pipefail

REPO="${1:-jphermans/hermes-obsidian}"

label() {
  local name="$1" color="$2" description="$3"
  gh label create "$name" --repo "$REPO" --color "$color" --description "$description" --force >/dev/null
  printf '  %-20s %s\n' "$name" "$description"
}

echo "Stock labels (kept, descriptions aligned with GitHub defaults):"
label "bug"              "d73a4a" "Something is not working."
label "documentation"    "0075ca" "Improvements or additions to documentation."
label "duplicate"        "cfd3d7" "This issue or pull request already exists."
label "enhancement"      "a2eeef" "New feature or request."
label "good first issue" "7057ff" "Good for newcomers."
label "help wanted"      "008672" "Extra attention is needed."
label "invalid"          "e4e669" "This does not seem right."
label "question"         "d876e3" "Further information is requested."
label "wontfix"          "ffffff" "This will not be worked on."
label "accessibility"    "f143ab" "Barrier affecting people with disabilities."

echo
echo "Triage:"
label "needs-triage"   "fbca04" "Not reviewed yet: classify, prioritise and route it."
label "priority: high" "b60205" "Blocks normal use, or risks losing work."
label "priority: medium" "d93f0b" "Should be fixed, but there is a workaround."
label "priority: low"  "fef2c0" "Nice to have."

echo
echo "Area:"
label "area: connection"    "0e8a16" "API server URL, key, profile prefix, CORS, transport, timeouts."
label "area: mobile"        "1d76db" "iOS and Android behaviour: reachability, keyboard, touch targets."
label "area: conventions"   "5319e7" "Vault analysis: properties, tags, links, headings, file names."
label "area: prompts"       "c2e0c6" "What the model is asked, and the quality of the notes it returns."
label "area: ui"            "bfd4f2" "Settings page, modals, chat panel, dark and light theming."
label "area: safety"        "e11d48" "Vault writes, previews, frontmatter merging, privacy, secrets."
label "area: ci"            "d4c5f9" "Build, tests, release workflow, BRAT packaging."

echo
echo "Compatibility:"
label "compat: obsidian" "f9d0c4" "Obsidian API or version compatibility, desktop and mobile."
label "compat: hermes"   "c5def5" "Hermes Agent API server behaviour and version differences."

echo
echo "Done. ${REPO} now has $(gh label list --repo "$REPO" --limit 100 --json name -q 'length') labels."
