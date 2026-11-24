// Firebase layer: Google sign-in, Firestore lists, live updates and invites.
//
// Data model
//   users/{uid}                     { activeListId, lists: { [listId]: listName } }
//   lists/{listId}                  { name, ownerId, inviteCode, createdAt }
//   lists/{listId}/members/{uid}    { uid, name, email, photo, joinedAt, inviteCode? }
//   lists/{listId}/invites/{code}   { listName, ownerName, createdAt }   (doc id = secret code)
//   lists/{listId}/items/{itemId}   { name, qty, done, price, createdAt, sortKey, updatedBy, updatedByName, updatedAt }
//
// Access rules live in firestore.rules.

const V = "11.0.2";
const SDK = `https://www.gstatic.com/firebasejs/${V}`;

export async function createCloud(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const {
    getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup,
    signInWithRedirect, getRedirectResult, signOut,
  } = A;
  const {
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch,
    onSnapshot, serverTimestamp, deleteField,
  } = F;

  const app = initializeApp(config);
  // Usage statistics (Google Analytics for Firebase): only after the user agrees
  // (setAnalytics(true)), and only when the project has it (config.measurementId).
  // Until then nothing is loaded, stored or sent, not even Google's cookies.
  let analytics = null, logEventFn = null, setCollection = null, analyticsOn = false, loading = null;
  async function setAnalytics(on) {
    analyticsOn = !!on && !!config.measurementId;
    if (analyticsOn && !analytics) {
      loading ||= import(`${SDK}/firebase-analytics.js`).then(async (M) => {
        if (!(await M.isSupported())) return;
        analytics = M.getAnalytics(app); // also logs the first page view
        logEventFn = M.logEvent;
        setCollection = M.setAnalyticsCollectionEnabled;
      }).catch((e) => console.warn("Analytics unavailable", e));
      await loading;
    }
    if (analytics) setCollection(analytics, analyticsOn);
    if (!analyticsOn) {
      // Forget this device: remove Google Analytics' cookies.
      document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter((n) => /^_ga/.test(n)).forEach((n) => {
        document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${location.hostname.split(".").slice(-2).join(".")}`;
      });
    }
  }
  const auth = getAuth(app);
  auth.languageCode = "he";
  let db;
  try {
    // Offline support: the list keeps working without network and syncs later.
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (_) {
    db = initializeFirestore(app, {});
  }

  let listId = null;
  let subs = [];
  let userSub = null;
  const recentlyDeleted = new Set();

  const me = () => auth.currentUser;
  const firstName = () => {
    const u = me();
    return ((u && (u.displayName || u.email)) || "").split(/[\s@]/)[0] || "מישהו";
  };
  const randomCode = () => {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  const listRef = (id = listId) => doc(db, "lists", id);
  const itemRef = (id) => doc(db, "lists", listId, "items", id);
  const userRef = () => doc(db, "users", me().uid);

  const memberData = () => {
    const u = me();
    return {
      uid: u.uid,
      name: u.displayName || u.email || "",
      email: u.email || "",
      photo: u.photoURL || "",
      joinedAt: serverTimestamp(),
    };
  };
  const stamp = () => ({ updatedBy: me().uid, updatedByName: firstName(), updatedAt: serverTimestamp() });
  const itemData = (it) => ({
    name: it.name, qty: it.qty, done: !!it.done, price: it.price ?? null,
    barcode: it.barcode ?? null, productName: it.productName ?? null,
    createdAt: it.createdAt || Date.now(), sortKey: it.sortKey || Date.now(), ...stamp(),
    // Who added the item (kept when it's restored by undo) and who last edited it.
    // A new item gets whoever adds it. An item put back (undo) keeps what it had,
    // even "nobody recorded" for items saved before adders were tracked.
    ...("createdBy" in it
      ? { createdBy: it.createdBy ?? null, createdByName: it.createdByName ?? null }
      : { createdBy: me().uid, createdByName: firstName() }),
    editedBy: it.editedBy ?? null, editedByName: it.editedByName ?? null,
    askedBy: it.askedBy ?? null,
  });
  const fromDoc = (d) => {
    const x = d.data();
    return { id: d.id, name: x.name, qty: x.qty, done: x.done, price: x.price ?? null,
      barcode: x.barcode ?? null, productName: x.productName ?? null,
      createdAt: x.createdAt, sortKey: x.sortKey, updatedBy: x.updatedBy, updatedByName: x.updatedByName,
      createdBy: x.createdBy ?? null, createdByName: x.createdByName ?? null,
      editedBy: x.editedBy ?? null, editedByName: x.editedByName ?? null, askedBy: x.askedBy ?? null };
  };

  function closeList() {
    subs.forEach((u) => u());
    subs = [];
    listId = null;
  }

  return {
    get user() { return me(); },
    get listId() { return listId; },

    onAuth(cb) {
      getRedirectResult(auth).catch((e) => console.warn("redirect sign-in", e));
      return onAuthStateChanged(auth, cb);
    },

    async signIn() {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(e.code)) {
          return signInWithRedirect(auth, provider);
        }
        if (["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(e.code)) return;
        throw e;
      }
    },

    async signOut() {
      closeList();
      if (userSub) { userSub(); userSub = null; }
      await signOut(auth);
    },

    // ----- user index of lists -----
    async getUserData() {
      const s = await getDoc(userRef());
      return s.exists() ? s.data() : { lists: {} };
    },
    watchUser(cb) {
      if (userSub) userSub();
      userSub = onSnapshot(userRef(), (s) => cb(s.exists() ? s.data() : { lists: {} }), (e) => console.warn(e));
    },
    setActive(id) {
      return setDoc(userRef(), { activeListId: id }, { merge: true });
    },
    indexList(id, name) {
      return setDoc(userRef(), { activeListId: id, lists: { [id]: name || "רשימה" } }, { merge: true });
    },
    // Members the owner lets edit a locked list (owner only; enforced by the database rules).
    setEditors(uids) {
      return updateDoc(listRef(), { editors: uids });
    },
    // Plan the shopping (owner only): when it happens and when the list locks by itself.
    // Times are epoch milliseconds or null; stored as Firestore timestamps.
    setPlan({ shopAt, lockAt, locked }) {
      const ts = (ms) => (ms ? new Date(ms) : null);
      return updateDoc(listRef(), { shopAt: ts(shopAt), lockAt: ts(lockAt), ...(locked === undefined ? {} : { locked }) });
    },
    // Lock / unlock the open list (owner only; enforced by the database rules).
    setLocked(locked) {
      return updateDoc(listRef(), { locked: !!locked });
    },
    // Usage statistics on/off (the user's choice), and counting an event (no-op when off).
    setAnalytics,
    track(name, params = {}) {
      try { if (analyticsOn && analytics) logEventFn(analytics, name, params); } catch (_) {}
    },
    // Rename the open list (for everyone on it) and update my own list index.
    async renameList(name) {
      await updateDoc(listRef(), { name });
      await this.setIndexName(listId, name);
    },
    // Keep my list index (the names in the list switcher) in step with a list's name.
    setIndexName(id, name) {
      return updateDoc(userRef(), { [`lists.${id}`]: name }).catch(() => {});
    },
    unindexList(id) {
      return updateDoc(userRef(), { [`lists.${id}`]: deleteField() }).catch(() => {});
    },

    // ----- lists -----
    async createList(items = [], listName = "") {
      const id = doc(collection(db, "lists")).id;
      const code = randomCode();
      const u = me();
      const name = String(listName || "").trim().slice(0, 80) || `הרשימה של ${firstName()}`;
      const b = writeBatch(db);
      b.set(doc(db, "lists", id), { name, ownerId: u.uid, inviteCode: code, createdAt: serverTimestamp() });
      b.set(doc(db, "lists", id, "members", u.uid), memberData());
      b.set(doc(db, "lists", id, "invites", code), { listName: name, ownerName: u.displayName || "", createdAt: serverTimestamp() });
      items.slice(0, 400).forEach((it) => b.set(doc(db, "lists", id, "items", it.id), itemData(it)));
      b.set(userRef(), { activeListId: id, lists: { [id]: name } }, { merge: true });
      await b.commit();
      return id;
    },

    async join(id, code) {
      // Already a member? Reading the list only succeeds for members.
      try {
        const s = await getDoc(listRef(id));
        if (s.exists()) { await this.indexList(id, s.data().name); return id; }
      } catch (e) {
        if (e.code !== "permission-denied") throw e;
      }
      const inv = await getDoc(doc(db, "lists", id, "invites", code));
      if (!inv.exists()) throw Object.assign(new Error("Invalid invite"), { code: "invalid-invite" });
      await setDoc(doc(db, "lists", id, "members", me().uid), { ...memberData(), inviteCode: code });
      await this.indexList(id, inv.data().listName);
      return id;
    },

    open(id, h) {
      closeList();
      listId = id;
      let settled = false; // ignore the initial load when reporting "someone else changed X"
      const fail = (e) => {
        if (e.code === "permission-denied") h.onLost();
        else console.error(e);
      };

      subs.push(onSnapshot(listRef(id), (s) => (s.exists() ? h.onList({ id, ...s.data() }) : h.onLost()), fail));
      subs.push(onSnapshot(collection(db, "lists", id, "members"),
        (s) => h.onMembers(s.docs.map((d) => ({ id: d.id, ...d.data() }))), fail));
      subs.push(onSnapshot(collection(db, "lists", id, "items"), { includeMetadataChanges: true }, (s) => {
        if (settled) {
          const remote = [];
          s.docChanges().forEach((c) => {
            const it = fromDoc(c.doc);
            if (c.type === "removed") {
              if (recentlyDeleted.delete(c.doc.id)) return;
              remote.push({ type: "removed", item: it });
            } else if (!c.doc.metadata.hasPendingWrites && it.updatedBy !== me().uid) {
              remote.push({ type: c.type, item: it, by: it.updatedByName });
            }
          });
          if (remote.length) h.onRemote(remote);
        }
        if (!s.metadata.fromCache) settled = true;
        h.onItems(s.docs.map(fromDoc));
      }, fail));
    },
    close: closeList,

    // ----- items (same interface as the local backend) -----
    put(items) {
      const b = writeBatch(db);
      items.forEach((it) => { recentlyDeleted.delete(it.id); b.set(itemRef(it.id), itemData(it)); });
      return b.commit();
    },
    patch(ids, fields) {
      const b = writeBatch(db);
      // Changing what the item is (name, amount, price, product) counts as an edit;
      // ticking it into the cart doesn't.
      const edited = !("askedBy" in fields) && ["name", "qty", "price", "barcode", "productName"].some((k) => k in fields);
      const by = edited ? { editedBy: me().uid, editedByName: firstName() } : {};
      ids.forEach((id) => b.update(itemRef(id), { ...fields, ...by, ...stamp() }));
      return b.commit();
    },
    del(ids) {
      const b = writeBatch(db);
      ids.forEach((id) => { recentlyDeleted.add(id); b.delete(itemRef(id)); });
      return b.commit();
    },

    // The store a shared list is priced at, so everyone on the list sees the same total.
    setListStore(store, branch = null) {
      return updateDoc(listRef(), { store: store || null, branch: branch || null });
    },

    // ----- sharing -----
    async resetInvite(list) {
      const code = randomCode();
      const b = writeBatch(db);
      if (list.inviteCode) b.delete(doc(db, "lists", list.id, "invites", list.inviteCode));
      b.set(doc(db, "lists", list.id, "invites", code), { listName: list.name, ownerName: me().displayName || "", createdAt: serverTimestamp() });
      b.update(listRef(list.id), { inviteCode: code });
      await b.commit();
    },
    removeMember(uid) {
      return deleteDoc(doc(db, "lists", listId, "members", uid));
    },
    // Delete one of my lists for everyone (owner). Order matters for the database rules:
    // items first (while I'm still a member), then invites and other members, then the
    // list and my own membership; finally it leaves my list index.
    async deleteList(id) {
      if (id === listId) closeList();
      const ref = doc(db, "lists", id);
      const snap = await getDoc(ref);
      const items = await getDocs(collection(db, "lists", id, "items"));
      for (let k = 0; k < items.docs.length; k += 400) {
        const b = writeBatch(db);
        items.docs.slice(k, k + 400).forEach((d) => b.delete(d.ref));
        await b.commit();
      }
      const members = await getDocs(collection(db, "lists", id, "members"));
      const b = writeBatch(db);
      if (snap.exists() && snap.data().inviteCode) b.delete(doc(db, "lists", id, "invites", snap.data().inviteCode));
      members.docs.filter((d) => d.id !== me().uid).forEach((d) => b.delete(d.ref));
      await b.commit();
      const last = writeBatch(db);
      last.delete(ref);
      last.delete(doc(db, "lists", id, "members", me().uid));
      await last.commit();
      await this.unindexList(id);
    },
    // Is this list mine? (Only members can read it; a list I can't read isn't mine.)
    async isOwnerOf(id) {
      try { const s = await getDoc(doc(db, "lists", id)); return s.exists() && s.data().ownerId === me().uid; }
      catch (_) { return false; }
    },
    // Leave a list someone else owns (it disappears from my lists).
    async leaveList(id) {
      if (id === listId) closeList();
      await deleteDoc(doc(db, "lists", id, "members", me().uid));
      await this.unindexList(id);
    },
    async leave() {
      const id = listId;
      closeList();
      await deleteDoc(doc(db, "lists", id, "members", me().uid));
      await this.unindexList(id);
    },
  };
}
