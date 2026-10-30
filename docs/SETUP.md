# Setup guide

Four credentials are involved. They are configured separately, and one working never proves another works:

| # | Credential | Used by | Set up with | Verified by |
|---|---|---|---|---|
| A | Claude Code login | Claude Code itself | `claude` → `/login` | `claude auth status` |
| B | DevPanel MCP authentication | Claude Code's connection to DevPanel MCP | `/mcp` in Claude Code (browser sign-in) | `/mcp` status, then `devpanel_whoami` |
| C | GitHub CLI authentication | `gh` (repository access, branch creation) | `gh auth login` | `gh auth status`, repository access check |
| D | GitHub PAT **classic** saved in DevPanel | DevPanel itself (repository access during project creation and deployment) | Created manually on GitHub; saved via the helper or the DevPanel UI | `devpanel_whoami` (`githubUsername`), `devpanel_list_git_owners` |

Installing the toolkit grants no GitHub or DevPanel access.

The guided script runs the steps below in order and can resume: `scripts/setup.sh --scope user` (add `--from-step N` to resume). The manual equivalent:

## 1. Claude Code and dependencies

Required: Claude Code, Git. Needed by workflows: `gh` (branch work), Node.js 18+ (skill helpers and the PAT helper), `curl` (site checks). Log in to Claude Code (`claude`, then `/login`).

## 2. Install the skill

```bash
installers/install-claude-code.sh --scope user                          # ~/.claude/skills
installers/install-claude-code.sh --scope project --project-dir ~/site  # ~/site/.claude/skills
```

Restart Claude Code (or start a new session) so it loads the skill.

## 3. Configure DevPanel MCP and sign in

If the `devpanel` MCP server is not configured yet:

```bash
installers/install-claude-code.sh --scope user --configure-mcp <DevPanel MCP URL>
```

This runs `claude mcp add --transport http --scope user devpanel <URL>` and never changes an existing `devpanel` entry. Then in Claude Code run `/mcp`, select `devpanel` and complete the browser sign-in. `claude mcp get devpanel` should show `Status: ✔ Connected`.

## 4. Verify DevPanel identity and workspace access

In Claude Code: *"Check my DevPanel toolkit setup."* The skill calls `devpanel_whoami` and `devpanel_list_workspaces` and reports the identity, `githubUsername` and workspaces.

From a terminal instead (separate sign-in; the helper cannot use Claude Code's MCP session):

```bash
node scripts/dp-mcp-helper.mjs check --server-url <DevPanel MCP URL>
```

## 5. GitHub CLI

```bash
gh auth login
gh auth status
skills/devpanel-project-lifecycle/scripts/gh-branch.sh access OWNER/REPO   # optional: repository access and push permission
```

## 6. GitHub PAT classic in DevPanel

1. Create the token yourself on GitHub: <https://github.com/settings/tokens/new?scopes=repo&description=DevPanel> — **classic** token, scope `repo`; for organizations with SAML SSO, authorize the token for them. Fine-grained tokens and `gh auth token` output are not PATs classic.
2. Save it in DevPanel, **either**:
   - **Helper** (in your own terminal, not through Claude):
     ```bash
     node scripts/dp-mcp-helper.mjs set-git-token --server-url <DevPanel MCP URL>
     ```
     It signs in to DevPanel MCP itself (browser OAuth), shows the DevPanel identity for you to confirm, reads the token with hidden input, checks with GitHub that it is a classic token with `repo` scope owned by the GitHub username, then calls `devpanel_set_git_token` and verifies with `devpanel_list_git_owners`. The token is held only in the helper's memory; it is never an argument, environment variable, file or log line. The helper refuses to run inside a Claude Code session.
   - **DevPanel UI** (tested baseline): save the token and GitHub username in your DevPanel account's Git settings.
3. The toolkit never extracts `gh` credentials and never copies them into DevPanel. If you deliberately want the same PAT classic for both, configure each yourself.

Never paste a token into the Claude conversation. If that happens, revoke it on GitHub and create a new one.

## 7. Final diagnostics

```bash
scripts/doctor.sh                                         # local checks (A, skill, B status, C)
scripts/doctor.sh --repo OWNER/REPO --live --server-url <DevPanel MCP URL>   # plus B identity and D via the helper
```

`doctor.sh` reports installed-but-not-configured states separately (for example "configured but not authenticated"). Fix the reported step and re-run it, or resume `setup.sh --from-step N`; the skill does not need to be reinstalled.

## Helper authentication modes

| DevPanel MCP deployment | Helper options |
|---|---|
| HTTP with MCP OAuth (sign-in in browser) | `--server-url URL` (default `--auth oauth`; add `--no-browser` to only print the URL) |
| HTTP with a static bearer / bring-your-own token | `--server-url URL --auth bearer` (hidden input) or `--bearer-fd N` |

Non-interactive token input for automation you control: `--token-fd 3 3< <(your-secret-manager read github/pat)`.
