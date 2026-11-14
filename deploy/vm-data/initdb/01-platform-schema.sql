-- The Prisma migrations create tables unqualified, while schema.prisma maps the
-- models to the "platform" schema. On a fresh database, create the schema and put
-- it first in the search_path so `prisma migrate deploy` lands the tables there.
CREATE SCHEMA IF NOT EXISTS platform;
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path TO platform, public', current_database());
END
$$;
