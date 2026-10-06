# @terrablox/git

Reads and writes git repositories through their host's API.

A project's Terraform lives in the user's own repository, so Terrablox has to read it,
commit to it, and start workflows in it. This package is all of that, and nothing else:
it takes a token as an argument, speaks HTTP, and returns plain objects.

## Why it is a package

Because it was two.

`lib/github/repo-files.ts` exported a `githubFetch`, and `lib/git-provider/github.ts` had
a private one of its own that assembled `https://api.github.com/…` by hand. Both could
list a repository tree. They threw different error classes, so what a failure looked like
depended on which of the two a caller happened to reach — and nothing at the call site
said which that was. Thirteen files used one, eleven the other.

Folding them together removed the duplicate and made room for one improvement worth
naming: GitHub answers a permission it does not like with `404 Not Found` and says
nothing about permissions. `GithubRequestError` now reads `x-oauth-scopes` and
`x-accepted-oauth-scopes` and, when the endpoint asked for something the token does not
have, says so in the message. The old client collected those headers and no caller ever
read them; a real afternoon went into a bare 404 from `POST /git/trees` that meant
"this token has no `workflow` scope".

## Layout

| Entry point | Holds |
| --- | --- |
| `./client` | `githubRequest`, `GithubRequestError` — the only place a request is made |
| `./repositories` | Describing a repository, listing where a new one may go, creating it |
| `./files` | Reading a file, committing several as one revision, listing the tree |
| `./actions` | Workflow runs, dispatching one, and the variables a workflow reads |
| `./types` | The shapes a host has to answer in, and `IGitProvider` |
| `./github-provider` | The GitHub implementation of that interface |

## The seam for a second host

`IGitProvider` has one implementation. It exists so the routes ask *a provider* rather
than GitHub, which makes adding GitLab a matter of implementing the interface and widening
`GitProviderId` — rather than finding every `api.github.com` in the app.

Two things to know before doing that. The DTO field names follow GitHub's own JSON where
the value is passed straight through (`full_name`, `tag_name`) and camelCase where this
package derives it; those names are a promise to the callers, so a second host maps onto
them rather than the other way round. And `./client` is GitHub-specific by design — a
second host brings its own transport, and `IGitProvider` is what keeps that invisible
further up.

## No `server-only`

Deliberately, although every current caller runs on a server. The token is a parameter,
so nothing here holds a secret, and the marker would make the package unusable from a
CLI or a GitHub Action — which is half the reason for extracting it. The app keeps that
guarantee where it belongs: in the modules that *fetch* the token.
