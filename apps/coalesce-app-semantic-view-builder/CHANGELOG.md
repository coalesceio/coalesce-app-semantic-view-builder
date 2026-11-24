# Changelog

## 0.0.1 (alpha)

First release, for Snowflake workspaces.

- Author semantic views as nodes of Coalesce's Semantic View package
  (`@coalesce/snowflake/semantic-view` 1.1.0); the app offers to install the package.
- Visual join editor with composite primary keys, cardinality labels and a Snowflake check
  for duplicate or NULL keys.
- Dimensions, facts and metrics, Cortex Analyst instructions and verified queries.
- Issues linked to the setting to fix, including what the package can't store yet, names
  Cortex Analyst rejects (with **Make names uppercase**), and metrics that hide a column.
- Create in the workspace schema, test with `SEMANTIC_VIEW()` queries, check drift against
  Snowflake, and import existing semantic views.
- New views start in the workspace's default location (`locations.yml`).
- Test, Drift, Import and Check in Snowflake need a key-pair coa profile; with any other
  profile they say so, and creating views still works.
- Card positions are kept in `apps/.semantic-view-builder/layouts.json`, outside the app's
  folder, so updates keep them.
