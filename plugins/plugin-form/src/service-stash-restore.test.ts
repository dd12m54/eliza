/**
 * Regression test for FormService stash/restore across a same-room restart
 * (issue #22272). Exercises the real FormService against an in-memory component
 * store that mirrors the runtime's natural-key (entityId, type) semantics, so
 * the stash -> start-new-form -> restore path is proven end to end. Deterministic,
 * no live model.
 */
import type { Component, IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { FormService } from "./service";
import type { FormDefinition } from "./types";

const entityId = "00000000-0000-4000-8000-000000000401" as UUID;
const roomId = "00000000-0000-4000-8000-000000000402" as UUID;
const agentId = "00000000-0000-4000-8000-000000000403" as UUID;

function makeRuntime(): IAgentRuntime {
  const components = new Map<string, Component>();
  const keyFor = (entity: UUID, type: string) => `${entity}:${type}`;

  return {
    agentId,
    getRoom: async () => ({ id: roomId, worldId: agentId }),
    getComponent: async (entity: UUID, type: string) =>
      components.get(keyFor(entity, type)),
    getComponents: async (entity: UUID) =>
      Array.from(components.values()).filter((c) => c.entityId === entity),
    createComponent: async (component: Component) => {
      components.set(keyFor(component.entityId, component.type), component);
      return true;
    },
    updateComponent: async (component: Component) => {
      components.set(keyFor(component.entityId, component.type), component);
    },
    deleteComponent: async (id: UUID) => {
      for (const [key, component] of components) {
        if (component.id === id) components.delete(key);
      }
    },
    emitEvent: async () => undefined,
    registerTaskWorker: () => undefined,
    getTaskWorker: () => undefined,
    logger: {
      debug: () => undefined,
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
    },
  } as unknown as IAgentRuntime;
}

function signupForm(): FormDefinition {
  return {
    id: "signup",
    name: "Signup",
    controls: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "email", label: "Email", type: "email", required: true },
    ],
  };
}

describe("FormService stash/restore across same-room restart (issue #22272)", () => {
  let service: FormService;

  beforeEach(async () => {
    service = (await FormService.start(makeRuntime())) as FormService;
    service.registerForm(signupForm());
  });

  it("restores a stashed session after a new form starts in the same room", async () => {
    const first = await service.startSession("signup", entityId, roomId);
    await service.stash(first.id, entityId);

    // Start a brand-new form in the SAME room. Before the fix this overwrote the
    // stashed session's component (both keyed form_session:{roomId}), silently
    // destroying the user's stashed work.
    const second = await service.startSession("signup", entityId, roomId);
    expect(second.id).not.toBe(first.id);

    // Stashed session must still be retrievable.
    const stashed = await service.getStashedSessions(entityId);
    expect(stashed.map((s) => s.id)).toEqual([first.id]);

    // Clear the room so restore's active-session guard is satisfied.
    await service.cancel(second.id, entityId, true);

    const restored = await service.restore(first.id, entityId);
    expect(restored.id).toBe(first.id);
    expect(restored.status).toBe("active");

    const active = await service.getActiveSession(entityId, roomId);
    expect(active?.id).toBe(first.id);
  });

  it("still rejects a second active session in the same room", async () => {
    const first = await service.startSession("signup", entityId, roomId);
    expect(first.id).toBeTruthy();

    // A second active session in the same room must be rejected while one is
    // already active/ready. The keying fix must not weaken this invariant.
    await expect(
      service.startSession("signup", entityId, roomId),
    ).rejects.toThrow(/Active session already exists/);
  });
});

const roomIdB = "00000000-0000-4000-8000-000000000404" as UUID;

/**
 * Restart the service over the same persisted component store, the way a
 * real restart re-registers the (possibly changed) form definitions and
 * reads sessions back from storage instead of service memory.
 */
async function restartService(
  runtime: IAgentRuntime,
  form: FormDefinition,
): Promise<FormService> {
  const restarted = (await FormService.start(runtime)) as FormService;
  restarted.registerForm(form);
  return restarted;
}

async function fillSignup(service: FormService, sessionId: string) {
  await service.updateField(sessionId, entityId, "name", "Ada", 1, "manual");
  await service.updateField(
    sessionId,
    entityId,
    "email",
    "ada@example.com",
    1,
    "manual",
  );
}

describe("FormService persisted stash/restore readiness recompute (PR #36502)", () => {
  it("restores a completed form as ready after a service restart", async () => {
    const runtime = makeRuntime();
    const service = (await FormService.start(runtime)) as FormService;
    service.registerForm(signupForm());
    const session = await service.startSession("signup", entityId, roomId);
    await fillSignup(service, session.id);
    expect((await service.getActiveSession(entityId, roomId))?.status).toBe(
      "ready",
    );
    await service.stash(session.id, entityId);

    const restarted = await restartService(runtime, signupForm());
    const restored = await restarted.restore(session.id, entityId);

    // Before the fix, restore always reset a completed form to "active".
    expect(restored.status).toBe("ready");
    expect(restored.fields.name?.status).toBe("filled");
    expect(restored.fields.email?.status).toBe("filled");
    // Ownership, collision data, and history survive the round trip.
    expect(restored.entityId).toBe(entityId);
    expect(restored.roomId).toBe(roomId);
    expect(restored.history).toHaveLength(2);
    expect((await restarted.getActiveSession(entityId, roomId))?.id).toBe(
      session.id,
    );
  });

  it("restores as active when a required field was added after the stash", async () => {
    const runtime = makeRuntime();
    const service = (await FormService.start(runtime)) as FormService;
    service.registerForm(signupForm());
    const session = await service.startSession("signup", entityId, roomId);
    await fillSignup(service, session.id);
    await service.stash(session.id, entityId);

    // The form changed while stashed: a new required field with no answer.
    // Readiness must be recomputed against the current definition.
    const withPhone: FormDefinition = {
      ...signupForm(),
      controls: [
        ...signupForm().controls,
        { key: "phone", label: "Phone", type: "text", required: true },
      ],
    };
    const restarted = await restartService(runtime, withPhone);
    const restored = await restarted.restore(session.id, entityId);

    expect(restored.status).toBe("active");
    expect(restored.fields.name?.status).toBe("filled");
    expect(restored.fields.email?.status).toBe("filled");
    // A control added after the session started has no field entry at all;
    // checkAllRequiredFilled treats the missing entry as unfilled, which is
    // why the session stays active instead of flipping to ready.
    expect(restored.fields.phone).toBeUndefined();
    expect(restored.history).toHaveLength(2);
  });

  it("restores as ready when a required field was relaxed after the stash", async () => {
    const runtime = makeRuntime();
    const service = (await FormService.start(runtime)) as FormService;
    service.registerForm(signupForm());
    const session = await service.startSession("signup", entityId, roomId);
    // Only the name is answered, so the session is active, not ready.
    await service.updateField(session.id, entityId, "name", "Ada", 1, "manual");
    expect((await service.getActiveSession(entityId, roomId))?.status).toBe(
      "active",
    );
    await service.stash(session.id, entityId);

    // The email field is no longer required. Recomputing against the
    // current definition must promote the session to ready.
    const relaxed: FormDefinition = {
      ...signupForm(),
      controls: signupForm().controls.map((control) =>
        control.key === "email" ? { ...control, required: false } : control,
      ),
    };
    const restarted = await restartService(runtime, relaxed);
    const restored = await restarted.restore(session.id, entityId);

    expect(restored.status).toBe("ready");
    expect(restored.fields.name?.status).toBe("filled");
    expect(restored.history).toHaveLength(1);
  });

  it("restores into its own room while another room keeps its active session", async () => {
    const runtime = makeRuntime();
    const service = (await FormService.start(runtime)) as FormService;
    service.registerForm(signupForm());
    const session = await service.startSession("signup", entityId, roomId);
    await fillSignup(service, session.id);
    await service.stash(session.id, entityId);

    // A different room runs its own active session for the same form.
    const other = await service.startSession("signup", entityId, roomIdB);
    expect(other.roomId).toBe(roomIdB);

    const restarted = await restartService(runtime, signupForm());
    const restored = await restarted.restore(session.id, entityId);

    expect(restored.status).toBe("ready");
    expect(restored.roomId).toBe(roomId);
    expect((await restarted.getActiveSession(entityId, roomId))?.id).toBe(
      session.id,
    );
    // The other room's session is untouched by the restore.
    const otherAfter = await restarted.getActiveSession(entityId, roomIdB);
    expect(otherAfter?.id).toBe(other.id);
    expect(otherAfter?.status).toBe("active");
    expect(otherAfter?.fields.name?.status).toBe("empty");
  });

  it("still rejects restore when the target room already has an active session", async () => {
    const runtime = makeRuntime();
    const service = (await FormService.start(runtime)) as FormService;
    service.registerForm(signupForm());
    const session = await service.startSession("signup", entityId, roomId);
    await fillSignup(service, session.id);
    await service.stash(session.id, entityId);

    // A new session takes the room while the first one is stashed.
    const other = await service.startSession("signup", entityId, roomId);

    const restarted = await restartService(runtime, signupForm());
    await expect(restarted.restore(session.id, entityId)).rejects.toThrow(
      /Active session already exists in room/,
    );

    // Neither session changed: the stashed one stays stashed, the active
    // one stays active.
    expect(
      (await restarted.getStashedSessions(entityId)).map((s) => s.id),
    ).toEqual([session.id]);
    const active = await restarted.getActiveSession(entityId, roomId);
    expect(active?.id).toBe(other.id);
    expect(active?.status).toBe("active");
  });
});
