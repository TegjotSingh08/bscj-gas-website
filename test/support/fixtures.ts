/**
 * Starting state for an integration test, and nothing more.
 *
 * **The line this draws matters.** Fixtures establish what already exists when
 * a test begins — an agency, an administrator, a property somebody imported
 * last month, a PDF already uploaded. They never perform the business actions
 * the test is about. A journey that inserted a certificate row and called
 * itself released would be asserting against its own SQL.
 *
 * So everything here is deliberately *prior* state, written directly, and every
 * transition a test is actually checking goes through the application.
 *
 * Fictional throughout. `.example.invalid` cannot receive mail, by RFC.
 */

import { randomUUID } from "node:crypto";

import type { Connection } from "./disposable-postgres";

export type Fixture = {
  organisationId: string;
  otherOrganisationId: string;
  adminUserId: string;
  engineerUserId: string;
  otherEngineerUserId: string;
  agentUserId: string;
  otherAgentUserId: string;
  landlordId: string;
  propertyId: string;
  jobId: string;
  jobReference: string;
  /** Two uploaded documents, so a release and a correction each have one. */
  documentIds: string[];
};

/** A fictional agency, its people, one property and one job awaiting a release. */
export async function seed(connection: Connection): Promise<Fixture> {
  const q = connection.client;

  const organisationId = await one(
    q,
    `insert into agent_organisation (name, email) values
       ('Northgate Lettings (FIXTURE)', 'agency@fixture.example.invalid')
     returning id`,
  );
  const otherOrganisationId = await one(
    q,
    `insert into agent_organisation (name, email) values
       ('Rival Lettings (FIXTURE)', 'rival@fixture.example.invalid')
     returning id`,
  );

  const adminUserId = await user(connection, {
    email: "admin@fixture.example.invalid",
    name: "Fixture Admin",
    role: "admin",
    organisationId: null,
  });
  const engineerUserId = await user(connection, {
    email: "engineer@fixture.example.invalid",
    name: "Fixture Engineer",
    role: "engineer",
    organisationId: null,
  });
  const otherEngineerUserId = await user(connection, {
    email: "engineer2@fixture.example.invalid",
    name: "Other Fixture Engineer",
    role: "engineer",
    organisationId: null,
  });
  const agentUserId = await user(connection, {
    email: "agent@fixture.example.invalid",
    name: "Fixture Agent",
    role: "agent_owner",
    organisationId,
  });
  const otherAgentUserId = await user(connection, {
    email: "rival@fixture.example.invalid",
    name: "Rival Agent",
    role: "agent_owner",
    organisationId: otherOrganisationId,
  });

  const landlordId = await one(
    q,
    `insert into customer (agent_organisation_id, type, name, email, phone)
     values ($1, 'landlord', 'Ada Fixture', 'ada@fixture.example.invalid', '+447700900001')
     returning id`,
    [organisationId],
  );

  const propertyId = await one(
    q,
    `insert into property
       (agent_organisation_id, customer_id, house_or_name, street, town, postcode)
     values ($1, $2, '14', 'Fixture Street', 'Wolverhampton', 'WV1 1AA')
     returning id`,
    [organisationId, landlordId],
  );

  const jobReference = "BSCJ-FIXT01";
  const jobId = await one(
    q,
    `insert into job
       (reference, idempotency_key, agent_organisation_id, customer_id,
        billing_customer_id, property_id, product_id, source, scheduling_method,
        lifecycle_status, appliance_count, price_total_pence,
        customer_snapshot, property_snapshot, price_snapshot)
     values ($1, $1, $2, $3, $3, $4, 'cp12', 'portal', 'tenant_selected',
             'in_progress', 1, 4500,
             '{"name":"Ada Fixture"}'::jsonb,
             '{"postcode":"WV1 1AA"}'::jsonb,
             '{"totalPence":4500}'::jsonb)
     returning id`,
    [jobReference, organisationId, landlordId, propertyId],
  );

  /*
    Two uploaded PDFs, already in the store. Uploading is exercised in the
    journey test; here they are simply what a release has to choose between.
  */
  const documentIds: string[] = [];
  for (const label of ["first", "second"]) {
    documentIds.push(
      await one(
        q,
        `insert into document
           (job_id, agent_organisation_id, kind, filename, blob_key,
            content_type, size_bytes, uploaded_by)
         values ($1, $2, 'certificate', $3, $4, 'application/pdf', 2731, $5)
         returning id`,
        [
          jobId,
          organisationId,
          `TEST-NOT-VALID-${label}.pdf`,
          `fixture/${randomUUID()}`,
          adminUserId,
        ],
      ),
    );
  }

  return {
    organisationId,
    otherOrganisationId,
    adminUserId,
    engineerUserId,
    otherEngineerUserId,
    agentUserId,
    otherAgentUserId,
    landlordId,
    propertyId,
    jobId,
    jobReference,
    documentIds,
  };
}

async function user(
  connection: Connection,
  input: {
    email: string;
    name: string;
    role: string;
    organisationId: string | null;
  },
): Promise<string> {
  return one(
    connection.client,
    `insert into app_user (email, name, role, agent_organisation_id, is_active)
     values ($1, $2, $3, $4, true) returning id`,
    [input.email, input.name, input.role, input.organisationId],
  );
}

async function one(
  client: Connection["client"],
  sql: string,
  params: unknown[] = [],
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(sql, params);
  return rows[0].id;
}
