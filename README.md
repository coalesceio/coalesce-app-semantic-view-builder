# Semantic View Builder

A Coalesce Desktop app for building Snowflake semantic views as nodes of Coalesce's Semantic
View package. Install it from the app marketplace in Coalesce Desktop.

- [`apps/coalesce-app-semantic-view-builder/`](apps/coalesce-app-semantic-view-builder/) is
  the app, and the only folder the marketplace installs. Its README covers using, developing
  and releasing it.
- Everything else is a small Coalesce project for developing and testing the app: TPC-H
  source nodes on Snowflake's sample data (`nodes/`), the Semantic View package
  (`packages/`), and `workspace.example.yml` to copy to your own `workspace.yml`.
