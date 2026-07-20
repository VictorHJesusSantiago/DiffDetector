import { describe, expect, it } from "vitest";
import {
  parseGraphQLOperations,
  parseGrpcMethods,
  parseQueueTopics,
  parseCliCommands,
  parseWebSocketEvents,
  parseDbTables,
  parseRoles,
  parseAllExtraResources,
} from "../src/parsers/extraResourceParser.js";
import { findDocMentions } from "../src/parsers/mentionParser.js";

const CODE_DIR = "test/fixtures/extras/code";
const DOCS_DIR = "test/fixtures/extras/docs";

describe("extraResourceParser", () => {
  it("extrai operações GraphQL", async () => {
    const ops = await parseGraphQLOperations(CODE_DIR);
    expect(ops.map((o) => o.subject).sort()).toEqual(["Mutation.createOrder", "Query.getUser", "Query.listOrders"]);
  });

  it("extrai métodos gRPC", async () => {
    const methods = await parseGrpcMethods(CODE_DIR);
    expect(methods.map((m) => m.subject).sort()).toEqual(["OrderService.CancelOrder", "OrderService.CreateOrder"]);
  });

  it("extrai tópicos de fila", async () => {
    const topics = await parseQueueTopics(CODE_DIR);
    expect(topics.some((t) => t.subject === "order.created")).toBe(true);
  });

  it("extrai comandos de CLI", async () => {
    const commands = await parseCliCommands(CODE_DIR);
    expect(commands.map((c) => c.subject)).toContain("migrate");
  });

  it("extrai eventos de WebSocket, ignorando eventos nativos", async () => {
    const events = await parseWebSocketEvents(CODE_DIR);
    expect(events.map((e) => e.subject)).toEqual(["orderUpdated"]);
  });

  it("extrai tabelas de banco de migrations SQL", async () => {
    const tables = await parseDbTables(CODE_DIR);
    expect(tables.map((t) => t.subject)).toContain("orders");
  });

  it("extrai roles/permissões", async () => {
    const roles = await parseRoles(CODE_DIR);
    expect(roles.map((r) => r.subject)).toContain("superadmin");
  });
});

describe("findDocMentions", () => {
  it("identifica quais recursos extras foram mencionados na doc e quais não", async () => {
    const resources = await parseAllExtraResources(CODE_DIR);
    const mentions = await findDocMentions(DOCS_DIR, resources);
    const mentionedSubjects = new Set(mentions.map((m) => m.subject));

    expect(mentionedSubjects.has("Query.getUser")).toBe(true);
    expect(mentionedSubjects.has("order.created")).toBe(true);
    expect(mentionedSubjects.has("migrate")).toBe(true);
    expect(mentionedSubjects.has("Mutation.createOrder")).toBe(false);
    expect(mentionedSubjects.has("superadmin")).toBe(false);
  });
});
