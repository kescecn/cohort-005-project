import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "~/test/test-db";
import {
  categories,
  courses,
  CourseStatus,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  refunds,
  RefundStatus,
  UserRole,
  users,
  videoWatchEvents,
} from "~/db/schema";

const state = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("~/db", () => ({
  db: new Proxy({}, { get: (_t, prop) => (state.db as any)[prop] }),
}));

import {
  approveRefundRequest,
  declineRefundRequest,
  getOpenRefundRequests,
} from "./refund-review.server";

let db: TestDb;
let learnerId: number;
let adminId: number;
let courseId: number;
let lessonId: number;
let purchaseId: number;
let refundId: number;

beforeEach(() => {
  db = createTestDb();
  state.db = db;

  learnerId = db
    .insert(users)
    .values({ name: "Liam", email: "liam@example.com", role: UserRole.Student })
    .returning()
    .get().id;
  adminId = db
    .insert(users)
    .values({ name: "Ada", email: "ada@example.com", role: UserRole.Admin })
    .returning()
    .get().id;
  const categoryId = db
    .insert(categories)
    .values({ name: "Dev", slug: "dev" })
    .returning()
    .get().id;
  courseId = db
    .insert(courses)
    .values({
      title: "Intro to TypeScript",
      slug: "intro-ts",
      description: "d",
      salesCopy: "Learn it.",
      instructorId: adminId,
      categoryId,
      status: CourseStatus.Published,
      price: 79,
    })
    .returning()
    .get().id;
  const moduleId = db
    .insert(modules)
    .values({ courseId, title: "Basics", position: 1 })
    .returning()
    .get().id;
  lessonId = db
    .insert(lessons)
    .values({ moduleId, title: "Types", position: 1 })
    .returning()
    .get().id;
  db.insert(enrollments).values({ userId: learnerId, courseId }).run();
  db.insert(lessonProgress)
    .values({
      userId: learnerId,
      lessonId,
      status: LessonProgressStatus.Completed,
    })
    .run();
  purchaseId = db
    .insert(purchases)
    .values({ userId: learnerId, courseId, amountPaid: 79 })
    .returning()
    .get().id;
  refundId = db
    .insert(refunds)
    .values({ purchaseId, reason: "Bought the wrong one, sorry." })
    .returning()
    .get().id;
});

describe("approveRefundRequest", () => {
  it("approves for the full amount paid and records who decided", () => {
    approveRefundRequest(refundId, adminId);

    const refund = db.select().from(refunds).where(eq(refunds.id, refundId)).get()!;
    expect(refund.status).toBe(RefundStatus.Approved);
    expect(refund.amountRefunded).toBe(79);
    expect(refund.resolvedByUserId).toBe(adminId);
    expect(refund.resolvedAt).not.toBeNull();
  });

  it("ends Course Access but keeps Progress", () => {
    approveRefundRequest(refundId, adminId);

    const enrollment = db
      .select()
      .from(enrollments)
      .where(eq(enrollments.userId, learnerId))
      .get();
    const progress = db
      .select()
      .from(lessonProgress)
      .where(eq(lessonProgress.userId, learnerId))
      .all();

    expect(enrollment).toBeUndefined();
    expect(progress).toHaveLength(1);
  });

  it("rejects a second decision with a 409 and changes nothing", () => {
    approveRefundRequest(refundId, adminId);
    const before = db.select().from(refunds).where(eq(refunds.id, refundId)).get();

    expect(() => approveRefundRequest(refundId, adminId)).toThrowError(
      expect.objectContaining({ init: { status: 409 } })
    );
    expect(
      db.select().from(refunds).where(eq(refunds.id, refundId)).get()
    ).toEqual(before);
  });

  it("rejects an unknown Refund Request with a 404", () => {
    expect(() => approveRefundRequest(9999, adminId)).toThrowError(
      expect.objectContaining({ init: { status: 404 } })
    );
  });
});

describe("declineRefundRequest", () => {
  const reason = "You have watched most of the course already.";

  it("declines with the Decline Reason and leaves Course Access alone", () => {
    declineRefundRequest(refundId, adminId, reason);

    const refund = db.select().from(refunds).where(eq(refunds.id, refundId)).get()!;
    expect(refund.status).toBe(RefundStatus.Declined);
    expect(refund.declineReason).toBe(reason);
    expect(refund.amountRefunded).toBeNull();
    expect(refund.resolvedByUserId).toBe(adminId);
    expect(refund.resolvedAt).not.toBeNull();
    expect(
      db.select().from(enrollments).where(eq(enrollments.userId, learnerId)).get()
    ).toBeDefined();
  });

  it.each([
    ["too short", "No."],
    ["blank", "          "],
    ["too long", "x".repeat(1001)],
  ])("rejects a Decline Reason that is %s with a 400", (_label, bad) => {
    expect(() => declineRefundRequest(refundId, adminId, bad)).toThrowError(
      expect.objectContaining({ init: { status: 400 } })
    );
    expect(
      db.select().from(refunds).where(eq(refunds.id, refundId)).get()!.status
    ).toBe(RefundStatus.Open);
  });

  it("rejects a second decision with a 409", () => {
    declineRefundRequest(refundId, adminId, reason);
    expect(() => declineRefundRequest(refundId, adminId, reason)).toThrowError(
      expect.objectContaining({ init: { status: 409 } })
    );
  });
});

describe("getOpenRefundRequests", () => {
  it("shows the learner, course, amount, reason and progress", () => {
    const secondLessonId = db
      .insert(lessons)
      .values({ moduleId: db.select().from(modules).get()!.id, title: "Generics", position: 2 })
      .returning()
      .get().id;
    // Furthest point per lesson counts, not the sum of every heartbeat.
    for (const [lesson, position] of [
      [lessonId, 600],
      [lessonId, 1200],
      [secondLessonId, 1800],
    ] as const) {
      db.insert(videoWatchEvents)
        .values({ userId: learnerId, lessonId: lesson, eventType: "progress", positionSeconds: position })
        .run();
    }

    const [request] = getOpenRefundRequests();

    expect(request).toMatchObject({
      refundId,
      learnerName: "Liam",
      courseTitle: "Intro to TypeScript",
      amountPaid: 79,
      reason: "Bought the wrong one, sorry.",
      lessonsCompleted: 1,
      lessonsTotal: 2,
      hoursWatched: 0.83,
    });
  });

  it("lists only Open requests, oldest first", () => {
    db.update(refunds)
      .set({ requestedAt: "2026-11-10T00:00:00.000Z" })
      .where(eq(refunds.id, refundId))
      .run();
    const other = db
      .insert(users)
      .values({ name: "Mia", email: "mia@example.com", role: UserRole.Student })
      .returning()
      .get();
    const otherPurchase = db
      .insert(purchases)
      .values({ userId: other.id, courseId, amountPaid: 79 })
      .returning()
      .get();
    db.insert(refunds)
      .values({ purchaseId: otherPurchase.id, reason: "Not what I expected.", requestedAt: "2026-11-05T00:00:00.000Z" })
      .run();
    db.insert(refunds)
      .values({
        purchaseId: otherPurchase.id,
        reason: "Earlier one, declined.",
        status: RefundStatus.Declined,
        requestedAt: "2026-11-01T00:00:00.000Z",
      })
      .run();

    expect(getOpenRefundRequests().map((r) => r.learnerName)).toEqual([
      "Mia",
      "Liam",
    ]);
  });
});
