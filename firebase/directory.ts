// ProjectDirectory over Cloud Firestore, admin SDK. Order 0045.
//
// The collections and the security rules ALREADY EXIST and are not rebuilt here:
//
//   projects/{pid}                 allow get, list: if isMember(pid)
//   projects/{pid}/members/{uid}   existence + revoked != true IS membership
//
// and the rules already record why membership is a document rather than a custom claim -- a
// claim needs a token refresh to revoke, and revocation has to be immediate. That reasoning
// stands; this adapter writes the documents that model it.
//
// WRITES GO THROUGH THE ADMIN SDK, IN THE BRIDGE. The rules deny every client write and the
// project is on Spark, which has no Cloud Functions, so there is no API to defer to. Creating a
// project is a local act anyway -- it connects a repo, writes .agentic/ and generates role packs,
// all of which need the repo on disk. So the CLI creates and the browser lists. Client writes
// stay denied; nothing is loosened.

import type { Firestore, Transaction } from 'firebase-admin/firestore';

import {
  DEFAULT_ROLES,
  LastOwnerError,
  ProjectExistsError,
  type CreateProjectInput,
  type MemberRecord,
  type MemberUid,
  type ProjectDirectory,
  type ProjectRecord,
  type RoleSlug,
} from '../shared/store/directory.ts';
import type { ProjectId } from '../shared/store/types.ts';
import { consoleLogger, type Logger } from '../shared/log.ts';
import { systemClock, type Clock } from '../shared/clock.ts';

export interface FirestoreDirectoryOptions {
  db: Firestore;
  log?: Logger;
  clock?: Clock;
}

interface StoredMember {
  uid: string;
  role: RoleSlug;
  label: string;
  revoked: boolean;
  added_at: string;
}

export class FirestoreDirectory implements ProjectDirectory {
  private readonly db: Firestore;
  private readonly log: Logger;
  private readonly clock: Clock;

  constructor(opts: FirestoreDirectoryOptions) {
    this.db = opts.db;
    this.log = opts.log ?? consoleLogger;
    this.clock = opts.clock ?? systemClock;
  }

  private projectRef(pid: ProjectId) {
    return this.db.collection('projects').doc(pid);
  }
  private membersRef(pid: ProjectId) {
    return this.projectRef(pid).collection('members');
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const created_at = this.clock.iso();
    const record: ProjectRecord = {
      project_id: input.project_id,
      project_name: input.project_name,
      repo_url: input.repo_url,
      created_at,
      created_by: input.owner_uid,
    };

    // ONE TRANSACTION for the project and its first owner. A project that exists with no members
    // is invisible to its own creator, because isMember() gates every read -- so a partial create
    // is worse than a failed one. It would leave a project nobody can list, open or remove.
    await this.db.runTransaction(async (tx: Transaction) => {
      const ref = this.projectRef(input.project_id);
      const existing = await tx.get(ref);
      // Reads before writes, and the existence check inside the transaction: two `flotilla new`
      // runs racing on the same id must produce one project and one clear error, not a silent
      // merge of two people's repos.
      if (existing.exists) throw new ProjectExistsError(input.project_id);

      tx.create(ref, {
        project_id: record.project_id,
        project_name: record.project_name,
        repo_url: record.repo_url,
        created_at,
        created_by: input.owner_uid,
      });
      tx.create(this.membersRef(input.project_id).doc(input.owner_uid), {
        uid: input.owner_uid,
        role: 'owner' satisfies RoleSlug,
        label: input.owner_label,
        revoked: false,
        added_at: created_at,
      } satisfies StoredMember);

      // THE ROLE POLICY, written at birth. Order 0047.
      //
      // acquireScope enforces file_scope only where a policy exists, so writing it here is what
      // makes every project created through this path bounded. DEFAULT_ROLES is a template, not
      // a law -- file scope depends on repo layout -- so it is COPIED into the project rather
      // than referenced, and an owner can later change one project's scopes without changing
      // anybody else's.
      for (const def of Object.values(DEFAULT_ROLES)) {
        tx.create(this.projectRef(input.project_id).collection('roles').doc(def.slug), {
          slug: def.slug,
          file_scope: def.file_scope,
          deploy_scope: def.deploy_scope,
          capabilities: def.capabilities,
        });
      }
    });

    this.log.info('directory.project_created', 'project created with its first owner', {
      project_id: input.project_id, owner_uid: input.owner_uid, repo_url: input.repo_url,
    });
    return record;
  }

  async listProjects(uid: MemberUid): Promise<(ProjectRecord & { role: RoleSlug })[]> {
    // A collectionGroup query over members, filtered to this uid. The alternative -- read every
    // project then check membership -- costs a read per project in the whole system for a list
    // that is usually two or three entries.
    //
    // ONE `where`, NOT TWO, and revocation filtered below in code. Adding
    // `.where('revoked','==',false)` makes this a composite query, which production refuses with
    // FAILED_PRECONDITION until a composite index is built and deployed.
    //
    // Worth recording how that surfaced: THE EMULATOR DOES NOT ENFORCE INDEXES, so the
    // conformance suite passed on it while `flotilla ls` failed against production on the very
    // first run. Same class of emulator/production divergence as order 0042's lock-timeout, and
    // the same lesson -- the emulator is not a scale model of production, it is a different
    // implementation that agrees about most things.
    //
    // Filtering in code is not a workaround here, it is cheaper: a person belongs to a handful of
    // projects, so this reads a few extra revoked rows rather than requiring an index to be
    // deployed before the product works. The browser runs the identical single-field query, which
    // is also what the collection-group rule in firestore.rules permits.
    const memberships = await this.db.collectionGroup('members').where('uid', '==', uid).get();

    const out: (ProjectRecord & { role: RoleSlug })[] = [];
    for (const m of memberships.docs) {
      if (m.get('revoked') === true) continue;
      const projectRef = m.ref.parent.parent;
      if (!projectRef) continue; // a members doc with no parent is corruption, not a project
      const p = await projectRef.get();
      // A membership pointing at a project that does not exist is an inconsistency. Report it
      // rather than silently dropping it or inventing a placeholder row.
      if (!p.exists) {
        this.log.warn('directory.orphan_membership', 'membership references a project that does not exist', {
          uid, project_id: projectRef.id,
        });
        continue;
      }
      const data = p.data() as ProjectRecord;
      out.push({
        project_id: p.id,
        project_name: data.project_name ?? p.id,
        repo_url: data.repo_url ?? '',
        created_at: data.created_at ?? '',
        created_by: data.created_by ?? '',
        role: (m.get('role') as RoleSlug) ?? 'client',
      });
    }
    // Stable order, newest first. An unordered list reshuffles between renders (locked pattern 7).
    return out.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || a.project_id.localeCompare(b.project_id));
  }

  async getProject(project_id: ProjectId): Promise<ProjectRecord | null> {
    const snap = await this.projectRef(project_id).get();
    if (!snap.exists) return null; // absence is not an error
    const d = snap.data() as ProjectRecord;
    return {
      project_id: snap.id,
      project_name: d.project_name ?? snap.id,
      repo_url: d.repo_url ?? '',
      created_at: d.created_at ?? '',
      created_by: d.created_by ?? '',
    };
  }

  async addMember(project_id: ProjectId, uid: MemberUid, role: RoleSlug, label: string): Promise<void> {
    // merge:true so this is idempotent on uid, and `revoked: false` so re-adding a revoked
    // member restores them rather than leaving a member who is listed but cannot read.
    await this.membersRef(project_id).doc(uid).set(
      { uid, role, label, revoked: false, added_at: this.clock.iso() } satisfies StoredMember,
      { merge: true },
    );
    this.log.info('directory.member_added', 'member added', { project_id, uid, role });
  }

  async listMembers(project_id: ProjectId): Promise<MemberRecord[]> {
    const snap = await this.membersRef(project_id).get();
    return snap.docs
      .map((d) => {
        const m = d.data() as Partial<StoredMember>;
        return {
          uid: m.uid ?? d.id,
          role: (m.role as RoleSlug) ?? 'client',
          label: m.label ?? d.id,
          revoked: m.revoked === true,
          added_at: m.added_at ?? '',
        };
      })
      .sort((a, b) => a.uid.localeCompare(b.uid));
  }

  async setRole(project_id: ProjectId, uid: MemberUid, role: RoleSlug): Promise<void> {
    await this.guardLastOwner(project_id, uid, role === 'owner' ? 'keep' : 'demote', (tx, ref) => {
      tx.update(ref, { role });
    });
    this.log.info('directory.role_set', 'member role changed', { project_id, uid, role });
  }

  async revokeMember(project_id: ProjectId, uid: MemberUid): Promise<void> {
    await this.guardLastOwner(project_id, uid, 'demote', (tx, ref) => {
      // REVOKE, never delete. Deleting makes isMember() false too, but it also erases the record
      // that this uid was ever a member -- and the ledger references them by uid.
      tx.update(ref, { revoked: true });
    });
    this.log.info('directory.member_revoked', 'member revoked', { project_id, uid });
  }

  /**
   * Apply a member mutation, refusing if it would leave the project with no active owner.
   *
   * In a transaction, and reading the whole member list inside it: checking outside would let two
   * concurrent demotions each see the other owner still in place and both succeed, leaving a
   * project nobody can administer. The member list is bounded by the team size, so reading it
   * transactionally is cheap.
   */
  private async guardLastOwner(
    project_id: ProjectId,
    uid: MemberUid,
    intent: 'keep' | 'demote',
    mutate: (tx: Transaction, ref: FirebaseFirestore.DocumentReference) => void,
  ): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const ref = this.membersRef(project_id).doc(uid);
      const all = await tx.get(this.membersRef(project_id));
      const self = all.docs.find((d) => d.id === uid);
      if (!self) return; // nothing to change; absence is not an error

      if (intent === 'demote') {
        const activeOwners = all.docs.filter(
          (d) => d.get('role') === 'owner' && d.get('revoked') !== true,
        );
        const isTheOnlyOwner =
          activeOwners.length === 1 && activeOwners[0].id === uid && self.get('revoked') !== true;
        if (isTheOnlyOwner) throw new LastOwnerError(project_id, uid);
      }
      mutate(tx, ref);
    });
  }
}

export function createFirestoreDirectory(opts: FirestoreDirectoryOptions): FirestoreDirectory {
  return new FirestoreDirectory(opts);
}
