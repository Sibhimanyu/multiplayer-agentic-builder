// The ProjectDirectory conformance suite. Order 0045.
//
// Adapter-agnostic, exactly like conformance.ts: it imports no adapter and knows nothing about
// Firestore. If a test here needed `if (harness.name === ...)` the suite would be measuring an
// interpretation rather than a contract.
//
// The shape of these assertions follows the rules this project has paid for:
//
//   - assert the ARTIFACT, not the return value. Where an operation claims to have written
//     something, the suite reads it back through a different operation.
//   - assert the RULE, not the outcome. D3 checks that a revoked member is RETAINED rather than
//     merely absent from an allow-list, because deleting the row produces the same `listProjects`
//     result while destroying the record the ledger references.
//   - a negative assertion needs proof the thing could have appeared (entry 60's mirror). D5
//     proves the last-owner guard by showing the SAME operation succeeds once a second owner
//     exists -- otherwise "it threw" might mean the operation never works at all.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { MemberUid, ProjectDirectory, RoleSlug } from './directory.ts';
import { LastOwnerError, ProjectExistsError } from './directory.ts';

export interface DirectoryHarness {
  readonly name: string;
  readonly directory: ProjectDirectory;
  /** A project id nobody else in this run will use. */
  freshProjectId(): string;
  dispose(): Promise<void>;
}

export type DirectoryHarnessFactory = () => Promise<DirectoryHarness>;

export function registerDirectoryConformanceSuite(setup: DirectoryHarnessFactory): void {
  describe('section D: project directory conformance', () => {
    const OWNER: MemberUid = 'uid_owner';

    const make = async (h: DirectoryHarness, over: Partial<{ project_id: string; owner_uid: string }> = {}) => {
      const project_id = over.project_id ?? h.freshProjectId();
      const rec = await h.directory.createProject({
        project_id,
        project_name: 'Inventory Tracker',
        repo_url: 'Sibhimanyu/inventory-tracker',
        owner_uid: over.owner_uid ?? OWNER,
        owner_label: 'sibhi',
      });
      return { project_id, rec };
    };

    it('D1 createProject makes the project AND its first owner, atomically', async () => {
      const h = await setup();
      try {
        const { project_id, rec } = await make(h);
        assert.equal(rec.project_id, project_id);
        assert.equal(rec.repo_url, 'Sibhimanyu/inventory-tracker');
        assert.ok(rec.created_at, 'created_at must be set by the backend');

        // The ARTIFACT, read back through a different operation than the one that wrote it.
        const got = await h.directory.getProject(project_id);
        assert.ok(got, 'the project must be readable after creation');
        assert.equal(got.project_name, 'Inventory Tracker');

        // A project with no members is invisible to its own creator, because membership gates
        // every read. So the owner must exist from birth, not as a second step.
        const members = await h.directory.listMembers(project_id);
        assert.equal(members.length, 1, 'exactly one member at creation');
        assert.equal(members[0].uid, OWNER);
        assert.equal(members[0].role, 'owner');
        assert.equal(members[0].revoked, false);
      } finally { await h.dispose(); }
    });

    it('D2 createProject refuses an id that already exists, and does not modify it', async () => {
      const h = await setup();
      try {
        const { project_id } = await make(h);

        await assert.rejects(
          () => h.directory.createProject({
            project_id,
            project_name: 'Someone Else\'s Project',
            repo_url: 'other/repo',
            owner_uid: 'uid_intruder',
            owner_label: 'intruder',
          }),
          (err: unknown) => {
            assert.ok(err instanceof ProjectExistsError, `expected ProjectExistsError, got ${String(err)}`);
            return true;
          },
        );

        // Not merely "it threw": the original must be UNTOUCHED. A create that throws after
        // half-writing would leave the name and repo clobbered.
        const got = await h.directory.getProject(project_id);
        assert.equal(got?.project_name, 'Inventory Tracker', 'the existing project must be unchanged');
        assert.equal(got?.repo_url, 'Sibhimanyu/inventory-tracker');
        const members = await h.directory.listMembers(project_id);
        assert.equal(members.length, 1, 'and no intruder was added as a member');
        assert.equal(members[0].uid, OWNER);
      } finally { await h.dispose(); }
    });

    it('D3 listProjects is scoped to a uid, and a revoked member is retained not deleted', async () => {
      const h = await setup();
      try {
        const { project_id } = await make(h);
        const other = h.freshProjectId();
        await h.directory.createProject({
          project_id: other, project_name: 'Other', repo_url: 'x/y',
          owner_uid: 'uid_stranger', owner_label: 'stranger',
        });

        const mine = await h.directory.listProjects(OWNER);
        assert.ok(mine.some((p) => p.project_id === project_id), 'my project is listed');
        assert.ok(!mine.some((p) => p.project_id === other), 'a stranger\'s project is NOT listed');
        assert.equal(mine.find((p) => p.project_id === project_id)?.role, 'owner', 'the role comes back with it');

        // The uid is scoped to this project. listProjects is the one operation here with GLOBAL
        // reach, so a uid shared with another test would accumulate memberships and make these
        // counts meaningless -- which is exactly how this first failed.
        const dev = `uid_dev_${project_id}`;
        await h.directory.addMember(project_id, dev, 'backend', 'dev');
        assert.equal((await h.directory.listProjects(dev)).length, 1, 'a new member sees it');

        await h.directory.revokeMember(project_id, dev);
        assert.equal((await h.directory.listProjects(dev)).length, 0, 'a revoked member does not');

        // THE RULE, not the outcome. Deleting the row would also produce an empty listProjects
        // while destroying the record that this uid was ever a member -- which the ledger
        // references. Revocation is a state, not an absence.
        const members = await h.directory.listMembers(project_id);
        const devRow = members.find((m) => m.uid === dev);
        assert.ok(devRow, 'the revoked member is RETAINED in the member list');
        assert.equal(devRow.revoked, true, 'and is marked revoked rather than removed');
        assert.equal(devRow.role, 'backend', 'and keeps the role they held');
      } finally { await h.dispose(); }
    });

    it('D4 addMember is idempotent on uid and un-revokes', async () => {
      const h = await setup();
      try {
        const { project_id } = await make(h);
        const dev = 'uid_dev';
        await h.directory.addMember(project_id, dev, 'backend', 'dev');
        await h.directory.addMember(project_id, dev, 'frontend', 'dev renamed');

        const members = await h.directory.listMembers(project_id);
        assert.equal(members.filter((m) => m.uid === dev).length, 1, 'no duplicate member row');
        assert.equal(members.find((m) => m.uid === dev)?.role, 'frontend', 'role updated');
        assert.equal(members.find((m) => m.uid === dev)?.label, 'dev renamed', 'label updated');

        await h.directory.revokeMember(project_id, dev);
        await h.directory.addMember(project_id, dev, 'backend', 'dev');
        assert.equal(
          (await h.directory.listMembers(project_id)).find((m) => m.uid === 'uid_dev')?.revoked,
          false,
          're-adding a revoked member un-revokes them',
        );
      } finally { await h.dispose(); }
    });

    it('D5 the last owner cannot be revoked or demoted -- and the guard is not a blanket refusal', async () => {
      const h = await setup();
      try {
        const { project_id } = await make(h);

        await assert.rejects(
          () => h.directory.revokeMember(project_id, OWNER),
          (err: unknown) => err instanceof LastOwnerError,
          'revoking the only owner must throw',
        );
        await assert.rejects(
          () => h.directory.setRole(project_id, OWNER, 'backend'),
          (err: unknown) => err instanceof LastOwnerError,
          'demoting the only owner must throw',
        );
        // The owner is still there and still an owner: the refusal did not half-apply.
        const after = await h.directory.listMembers(project_id);
        assert.equal(after.find((m) => m.uid === OWNER)?.role, 'owner');
        assert.equal(after.find((m) => m.uid === OWNER)?.revoked, false);

        // THE CONTROL. "It threw" is worthless unless the same call succeeds when the guard's
        // precondition is gone -- otherwise the operation might simply never work.
        //
        // Order matters here, and getting it wrong is easy: demote the original owner FIRST and
        // the second owner becomes the last one, so revoking it is then correctly refused and
        // the control looks like a failure. Each control therefore runs while TWO active owners
        // exist, and the second owner is restored in between.
        await h.directory.addMember(project_id, 'uid_second', 'owner', 'second owner');
        await h.directory.revokeMember(project_id, 'uid_second');
        assert.equal(
          (await h.directory.listMembers(project_id)).find((m) => m.uid === 'uid_second')?.revoked,
          true,
          'with two owners present, the identical revocation SUCCEEDS',
        );

        await h.directory.addMember(project_id, 'uid_second', 'owner', 'second owner');
        await h.directory.setRole(project_id, OWNER, 'backend');
        assert.equal(
          (await h.directory.listMembers(project_id)).find((m) => m.uid === OWNER)?.role,
          'backend',
          'and so does the identical demotion',
        );

        // And the guard still holds for whoever is now alone.
        await assert.rejects(
          () => h.directory.revokeMember(project_id, 'uid_second'),
          (err: unknown) => err instanceof LastOwnerError,
          'the guard follows ownership rather than being attached to one uid',
        );
      } finally { await h.dispose(); }
    });

    it('D6 setRole changes only the named member, and getProject is null for what does not exist', async () => {
      const h = await setup();
      try {
        const { project_id } = await make(h);
        await h.directory.addMember(project_id, 'uid_a', 'backend', 'a');
        await h.directory.addMember(project_id, 'uid_b', 'frontend', 'b');
        await h.directory.setRole(project_id, 'uid_a', 'qa');

        const members = await h.directory.listMembers(project_id);
        assert.equal(members.find((m) => m.uid === 'uid_a')?.role, 'qa');
        assert.equal(members.find((m) => m.uid === 'uid_b')?.role, 'frontend', 'the other member is untouched');
        assert.equal(members.find((m) => m.uid === OWNER)?.role, 'owner', 'and so is the owner');

        // Absence is not an error.
        assert.equal(await h.directory.getProject(`${project_id}_nope`), null);
        assert.deepEqual(await h.directory.listMembers(`${project_id}_nope`), []);
        assert.deepEqual(await h.directory.listProjects('uid_nobody'), []);
      } finally { await h.dispose(); }
    });

    it('D7 every role slug round-trips unchanged', async () => {
      const h = await setup();
      try {
        const { project_id } = await make(h);
        const roles: RoleSlug[] = ['architect', 'backend', 'frontend', 'qa', 'client'];
        for (const [i, role] of roles.entries()) {
          await h.directory.addMember(project_id, `uid_${i}`, role, `member ${i}`);
        }
        const members = await h.directory.listMembers(project_id);
        for (const [i, role] of roles.entries()) {
          assert.equal(
            members.find((m) => m.uid === `uid_${i}`)?.role, role,
            `${role} must survive the round trip -- a backend that silently normalises a role is not storing it`,
          );
        }
      } finally { await h.dispose(); }
    });
  });
}
