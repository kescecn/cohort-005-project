import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "~/test/test-db";
import {
  courses,
  enrollments,
  purchases,
  refunds,
  RefundStatus,
  CourseStatus,
  UserRole,
  users,
  categories,
} from "~/db/schema";

const state = vi.hoisted(() => ({ db: undefined as unknown, userId: 0 }));

vi.mock("~/db", () => ({
  db: new Proxy({}, { get: (_t, prop) => (state.db as any)[prop] }),
}));
vi.mock("~/lib/session", () => ({
  getCurrentUserId: async () => state.userId,
}));
vi.mock("~/lib/country.server", () => ({
  resolveCountry: async () => "US",
}));

import { getAccess } from "./access.server";

let db: TestDb;
let courseId: number;
let purchaseId: number;

beforeEach(() => {
  db = createTestDb();
  state.db = db;

  const learner = db
    .insert(users)
    .values({ name: "Liam", email: "liam@example.com", role: UserRole.Student })
    .returning()
    .get();
  const instructor = db
    .insert(users)
    .values({ name: "Ines", email: "ines@example.com", role: UserRole.Instructor })
    .returning()
    .get();
  const category = db
    .insert(categories)
    .values({ name: "Dev", slug: "dev" })
    .returning()
    .get();
  const course = db
    .insert(courses)
    .values({
      title: "Intro to TypeScript",
      slug: "intro-ts",
      description: "d",
      salesCopy: "Learn it.",
      instructorId: instructor.id,
      categoryId: category.id,
      status: CourseStatus.Published,
      price: 79,
    })
    .returning()
    .get();
  courseId = course.id;
  db.insert(enrollments).values({ userId: learner.id, courseId }).run();
  purchaseId = db
    .insert(purchases)
    .values({ userId: learner.id, courseId, amountPaid: 79 })
    .returning()
    .get().id;
  state.userId = learner.id;
});

const request = new Request("http://localhost/");

describe("Course Access", () => {
  it("lets an enrolled learner view content", async () => {
    const access = await getAccess(request, courseId);
    expect(access.canViewContent).toBe(true);
  });

  it("is suspended while the learner has an Open Refund Request", async () => {
    db.insert(refunds)
      .values({ purchaseId, reason: "Bought the wrong one, sorry." })
      .run();

    const access = await getAccess(request, courseId);
    expect(access.canViewContent).toBe(false);
  });

  it("returns when the Refund Request is declined", async () => {
    db.insert(refunds)
      .values({
        purchaseId,
        reason: "Bought the wrong one, sorry.",
        status: RefundStatus.Declined,
        declineReason: "You have watched most of the course.",
      })
      .run();

    const access = await getAccess(request, courseId);
    expect(access.canViewContent).toBe(true);
  });
});
