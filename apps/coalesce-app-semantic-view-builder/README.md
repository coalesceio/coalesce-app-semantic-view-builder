# Semantic View Builder

Build Snowflake semantic views on this workspace's dimensions and facts. Open it from the
Coalesce sidebar.

Each view is a node of Coalesce's **Semantic View package**
([`@coalesce/snowflake/semantic-view`](https://docs.coalesce.io/docs/marketplace/package/coalesce_snowflake_semantic-view),
node type "Semantic View"), saved as `nodes/<LOCATION>-<NAME>.yml`. The app is a visual
editor for those nodes: they appear in the DAG downstream of the tables they read, open in
Coalesce's own config panel too, and deploy with `coa create` / `coa plan` / `coa deploy`
like any other node. The package's template creates, replaces and drops the view.

**Alpha (0.0.x).** Install it from the app marketplace in Coalesce Desktop, which copies it
into the workspace's `apps/` folder; commit that folder so the rest of the team gets it.
It needs:

- a Snowflake workspace (semantic views are a Snowflake feature);
- Coalesce's Semantic View package, which the app offers to install (below);
- for **Test**, **Drift**, **Import** and **Check in Snowflake**, a key-pair coa profile (see
  [Snowflake access](#snowflake-access)). Everything else works with any profile.

**The package is required.** Coalesce has no way for an app to declare the packages it
needs (an app's `package.json` is read only for `name`, `description`, `version`,
`repository` and `scripts.start`), so the app checks for itself. Until the workspace has
the package's Semantic View node type, it opens on a setup screen instead of the editor:

- **Install the package** asks first, then adds `packages/semantic-view.yml` (release
  1.1.0, the one the app is verified against, in the same form Coalesce writes from Build
  Settings) and runs `coa install` with the workspace's profile to download it. The
  declaration is shared workspace configuration: once committed, everyone who uses the
  workspace gets the package. If the download fails, the app removes what it added and
  says why.
- When `packages/` already declares the package but it isn't downloaded on this machine
  (for example after pulling a teammate's commit), the button only runs `coa install`.
- Installing from Build Settings → Packages (package ID
  `@coalesce/snowflake/semantic-view`) works too; the app notices within a few seconds.

If the workspace has a different release than 1.1.0, the editor says so; `npm test`
compares the app's SQL with what that release renders.

## Using it

- **New semantic view**: the view starts in the workspace's default location
  (`defaultStorageMapping` in `locations.yml`); locations that hold only source nodes aren't
  offered. Pick nodes as tables. The primary key starts as the node's
  business key, joins are suggested where one table carries another's key columns, and you
  can add starter fields (one dimension or fact per column, plus SUM metrics). Suggested
  names are upper case, the only case Cortex Analyst accepts (see **Names** below).
- **Tables and joins**: a diagram of the tables with their columns.
  - Drag from a column onto the matching column of another table to join them, or drop on
    a card to join to its primary key. The arrow points at the table being looked up; the
    label gives the cardinality the keys imply (`N : 1`, `1 : 1`, or `N : N` in amber).
  - Click **PK** on a column to set the primary key, and on more columns for a composite
    key (`PK1`, `PK2`…). The table panel edits the key, can apply the node's business key,
    and has **Check in Snowflake**, which counts duplicate and NULL key values in the table
    in your workspace schema.
  - Drag a header to move a card; click a line or card to edit it in the side panel.
    Delete removes the selected join. Card positions are kept in the workspace at
    `apps/.semantic-view-builder/layouts.json`, not in the node, so moving a card is not a
    change to deploy. The file sits outside the app's own folder so that installing or
    updating the app keeps it, and it's shared through git like the nodes.
- **Fields**: dimensions, facts and metrics. A metric is COUNT, SUM, AVG, MIN or MAX of an
  expression, for example `COUNT(DISTINCT orders.ID)`.
- **Cortex Analyst**: SQL generation and question categorization instructions, and verified
  queries (question, SQL, onboarding, verified by, verified at).
- **SQL**: the statement the package creates for this node in your workspace schema.
- **Issues**: offline checks against node metadata and Snowflake's rules (unknown columns,
  missing keys, join loops, mismatched join types, metrics without an aggregate, a fact or
  dimension that reads a metric, lowercase names that Cortex Analyst rejects), plus what
  the package cannot store, labelled **package**. Snowflake checks the expressions
  themselves when the view is created. Each issue links to the place to fix it: it opens
  the right tab, selects the table or join, and focuses the setting to change (a key
  picker, a join's columns, a field's expression, a verified query's question…). The error
  and warning counts in the header open this tab.
- **Delete** removes the view's node file after you confirm (an unsaved draft shows
  **Discard draft** instead). The view already created in your workspace schema stays; in
  deployed environments, the next deploy of the deletion drops it.
- **Create in workspace schema**: saves, then runs `coa create` for this one node.
- **Test**: tick metrics and dimensions (or facts) and run a `SEMANTIC_VIEW()` query
  against the created view.
- **Drift**: compares the saved node with the view in the workspace schema (`DESCRIBE
  SEMANTIC VIEW`) and lists what differs.
- **Import from Snowflake**: lists the account's semantic views and turns one into a draft,
  mapping its tables to workspace nodes (exactly by database and schema, otherwise by name). The draft lands in the location mapped to
  the view's schema, or the default location.

Saving writes the node file only. Nothing is committed, and nothing reaches other
environments until you deploy.

## What the package cannot store yet

The package's node format (v1.1.0) has no place for these, so the app reports them as
**package** errors and refuses to save rather than drop them:

- Joins to a composite key, to a unique key or non-key column, and as-of joins. The package
  writes one column per relationship and always references the looked-up table's primary
  key, which Snowflake rejects for a composite key.
- Unique keys, private facts and metrics, and derived metrics (metrics across tables, or
  any metric that is not COUNT/SUM/AVG/MIN/MAX of one expression).
- The same node used as two tables (for example order date and ship date).
- More table synonyms than primary key columns (the package stores one per key row), and
  synonyms containing a comma or an apostrophe.

A table without a primary key works only when no table has one.

## How a view is stored

`src/pkg.js` converts between the app's spec and the package's node:

- **Config**: the package's settings: `primaryKeyConfig`, `foreignKeyConfig`,
  `factDetConfig`, `DimConfig`, `metricConfig`, the AI instructions and verified queries.
  `deriveCol` (the package's "Create Schema Table" option) is kept off.
- **Columns**: the physical source columns the view uses, with lineage to their source
  nodes. The package finds each table through that lineage.
- **Join**: written from the relationships as `LEFT JOIN` SQL, for people reading the node.
- **Names**: the package quotes table aliases and field names, so they keep their case.
  Name them in upper case (`ARR`, `TOTAL_ARR`): Cortex Analyst rejects the whole view if any
  table alias or field name has a lowercase letter ("invalid logical table name", checked
  2026-11-23); relationship names may be any case. Upper-case names also need no quotes in
  `SEMANTIC_VIEW()` queries and verified queries (`ARR.TOTAL_ARR`); lowercase ones must be
  quoted (`"arr"."total_arr"`). New views get upper-case names, and Issues warns about
  lowercase ones, one warning per table, with a **Make names uppercase** button. It renames
  every table alias and field at once and rewrites expressions so each still reads what it
  read before, plus quoted names in verified queries. It leaves a field alone when its
  upper-case name would hide a column other fields read (a metric named like a column, or a
  field named like a column it isn't a copy of) and says which, so you can pick another name.
  The rename only changes the draft; save to keep it.
- **References**: in expressions, `ALIAS.NAME` means the field with exactly that name,
  otherwise the physical column (an unquoted name means its upper-case form), otherwise a
  field whose name matches ignoring case. Snowflake resolves names the same way, so a field
  hides a column with the same name: a metric called `NEW_BUSINESS_ARR` turns a fact's
  `ARR.NEW_BUSINESS_ARR` into a reference to that metric, and Snowflake refuses to create
  the view. Issues reports it on the metric; rename the metric (`TOTAL_NEW_BUSINESS_ARR`).
  A field named like its own column (`ACCOUNT_ID AS ARR.ACCOUNT_ID`) reads the column.

Nodes made in Coalesce's own config panel open here too.

## Snowflake access

Creating a view goes through `coa create`, so it works with whatever sign-in the
workspace's coa profile uses. The app's own queries (**Test**, **Drift**, **Import**,
**Check in Snowflake**) go to Snowflake's SQL REST API with the same profile (named in
`workspace.yml`, stored in `~/.coa/config`), its role and its warehouse, and need key-pair
auth: the SQL API doesn't accept passwords, and the app can't use Coalesce Desktop's own
warehouse connection (Desktop only lets its own UI run SQL through it). With a password or
OAuth profile those four features say so, and the rest of the app works. The server accepts
connections from this machine only.

## Developing

```bash
npm install
npm run build        # bundles src/ + the yaml package into dist/server.js (commit it)
npm test             # spec and package-format checks; app DDL == package-rendered DDL
PORT=3918 node dist/server.js
```

`dist/server.js` is what Coalesce runs, so rebuild and commit it after changing `src/`.
`public/` is read once when the server starts, so the page always matches the server's API.
Coalesce keeps an app's server running until the app is reopened, so after any change close
the Semantic View Builder tab and open it again from Apps. If the page ever meets an older
server, it says so instead of failing; bump `API_VERSION` in both `src/server.js` and
`public/app.js` whenever an `/api` response changes shape. `toDDL()` in `src/pkg.js` mirrors the package's create
template. `npm test` renders the fixture through the installed package with
`coa create --dry-run` and fails when they diverge; it skips that check while the package
is not installed. The tests read nodes of the workspace the app was built in
(`FCT_MONTHLY_ACCOUNT_ARR`, `DIM_DATE`, `DIM_CONTACT`, `ACCOUNT`); `SVB_TEST_WORKSPACE=<dir>`
runs them against another workspace that has them.

## Releasing

Releases are published from
[coalesceio/coalesce-app-semantic-view-builder](https://github.com/coalesceio/coalesce-app-semantic-view-builder),
where the app sits in `apps/coalesce-app-semantic-view-builder/` (the marketplace requires
the folder to be named like the repository). Each `vX.Y.Z` tag is a version in Coalesce
Desktop's app marketplace, which lists public `coalesceio` repositories with the
`coalesce-app` topic and installs a tag's `apps/<repository>/` folder. Keep `version` in
`package.json` equal to the tag, note the release in `CHANGELOG.md`, and commit the built
`dist/server.js`: the marketplace has no build step.
