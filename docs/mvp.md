# PatchGraph MVP

## Basic Idea

PatchGraph is **not** an IDE.

It is a **local-first web app for reviewing and shaping code changes**.

The core idea is that standard diff viewers show what changed, but they are weak at showing how those changes relate to the rest of the codebase. That problem matters whether the changes were written by a human, an AI agent, or both.

PatchGraph should make code review feel more spatial and more connected:

- open a local repository in the browser
- load the current working tree diff or a selected branch diff
- show changed files or hunks as draggable windows on a canvas
- follow semantic links from changed code into definitions and nearby context
- take git actions directly from the review surface

The canvas is not there for novelty. Its job is to help answer:

- What changed?
- What else does this affect?
- Is this safe?
- Should I keep, split, or discard this change?

## Product Goal

PatchGraph is a **visual review workstation for local git changes**, with especially strong value in AI-heavy coding workflows.

The product thesis is:

- the unit of work is a **change set**, not a file tab
- git is the primary control surface
- semantic navigation exists to explain impact, not to build a whole-codebase graph

The long-term direction is still review-first, not editor-first. A future paid tier may add live AI-agent supervision, but the initial product must stand on its own as a strong local review tool.

## MVP Goal

The MVP should prove one concrete thing:

**Does a spatial, git-aware review workspace make code changes easier to understand, split, and accept than a normal diff viewer?**

To answer that, the MVP should let a user:

1. Open a local repo in the browser.
2. Load the current diff.
3. Open changed hunks or files as draggable windows on a canvas.
4. Click a changed symbol or call site and open the related definition in a linked context window.
5. Keep the original diff visible while inspecting nearby code.
6. Stage or unstage a hunk.
7. Discard a hunk carefully.
8. Save and restore the layout for a review session.

If that workflow does not outperform a normal diff tree for real review tasks, then the canvas is decorative and the product thesis is wrong.

## MVP Scope

Recommended scope for v1:

- local-first only
- web app only
- read-mostly review UX
- one language first
- hunk-level git actions
- definition navigation from changed code
- saved review layouts

## Out of Scope for V1

Do not build these into the MVP:

- full IDE editing
- terminal integration
- GitHub or GitLab PR sync
- multi-user collaboration
- full-codebase graph rendering
- automatic deep callgraph expansion
- multi-language support from day one
- live AI-agent streaming
- agent chat or interruption controls
- custom WASM-first rendering stack

## Lite and Pro Boundary

The first shipped product should be **lite only**.

Lite:

- review completed local changes on a canvas
- inspect semantic context
- interact with git safely

Pro later:

- stream a live view of an AI agent while it works
- chat with the agent
- interrupt or redirect the agent

That boundary is important because pro adds a second control plane. It should be a later expansion, not a source of scope creep inside the MVP.
