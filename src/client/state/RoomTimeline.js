import EventEmitter from 'events';
import initMatrix from '../initMatrix';
import cons from './cons';

function isEdited(mEvent) {
  return mEvent.getRelation()?.rel_type === 'm.replace';
}

function isReaction(mEvent) {
  return mEvent.getType() === 'm.reaction';
}

function getRelateToId(mEvent) {
  const relation = mEvent.getRelation();
  return relation && relation.event_id;
}

function addToMap(myMap, mEvent) {
  const relateToId = getRelateToId(mEvent);
  if (relateToId === null) return null;

  if (typeof myMap.get(relateToId) === 'undefined') myMap.set(relateToId, []);
  myMap.get(relateToId).push(mEvent);
  return mEvent;
}

function getFirstLinkedTimeline(timeline) {
  let tm = timeline;
  while (tm.prevTimeline) {
    tm = tm.prevTimeline;
  }
  return tm;
}
function getLastLinkedTimeline(timeline) {
  let tm = timeline;
  while (tm.nextTimeline) {
    tm = tm.nextTimeline;
  }
  return tm;
}

function iterateLinkedTimelines(timeline, backwards, callback) {
  let tm = timeline;
  while (tm) {
    callback(tm);
    if (backwards) tm = tm.prevTimeline;
    else tm = tm.nextTimeline;
  }
}

class RoomTimeline extends EventEmitter {
  constructor(roomId) {
    super();
    // These are local timelines
    this.timeline = [];
    this.editedTimeline = new Map();
    this.reactionTimeline = new Map();
    this.typingMembers = new Set();

    this.matrixClient = initMatrix.matrixClient;
    this.roomId = roomId;
    this.room = this.matrixClient.getRoom(roomId);

    this.liveTimeline = this.room.getLiveTimeline();
    this.activeTimeline = this.liveTimeline;

    this.isOngoingPagination = false;
    this.ongoingDecryptionCount = 0;
    this.initialized = false;

    // TODO: remove below line
    window.selectedRoom = this;
  }

  isServingLiveTimeline() {
    return getLastLinkedTimeline(this.activeTimeline) === this.liveTimeline;
  }

  canPaginateBackward() {
    const tm = getFirstLinkedTimeline(this.activeTimeline);
    return tm.getPaginationToken('b') !== null;
  }

  canPaginateForward() {
    return !this.isServingLiveTimeline();
  }

  isEncrypted() {
    return this.matrixClient.isRoomEncrypted(this.roomId);
  }

  clearLocalTimelines() {
    this.timeline = [];
    this.reactionTimeline.clear();
    this.editedTimeline.clear();
  }

  addToTimeline(mEvent) {
    if (mEvent.isRedacted()) return;
    if (isReaction(mEvent)) {
      addToMap(this.reactionTimeline, mEvent);
      return;
    }
    if (!cons.supportEventTypes.includes(mEvent.getType())) return;
    if (isEdited(mEvent)) {
      addToMap(this.editedTimeline, mEvent);
      return;
    }
    this.timeline.push(mEvent);
  }

  _populateAllLinkedEvents(timeline) {
    const firstTimeline = getFirstLinkedTimeline(timeline);
    iterateLinkedTimelines(firstTimeline, false, (tm) => {
      tm.getEvents().forEach((mEvent) => this.addToTimeline(mEvent));
    });
  }

  _populateTimelines() {
    this.clearLocalTimelines();
    this._populateAllLinkedEvents(this.activeTimeline);
  }

  async _reset(eventId) {
    if (this.isEncrypted()) await this.decryptAllEventsOfTimeline(this.activeTimeline);
    this._populateTimelines();
    if (!this.initialized) {
      this.initialized = true;
      this._listenEvents();
    }
    this.emit(cons.events.roomTimeline.READY, eventId ?? null);
  }

  async loadLiveTimeline() {
    this.activeTimeline = this.liveTimeline;
    await this._reset();
    return true;
  }

  async loadEventTimeline(eventId) {
    // we use first unfiltered EventTimelineSet for room pagination.
    const timelineSet = this.getUnfilteredTimelineSet();
    try {
      const eventTimeline = await this.matrixClient.getEventTimeline(timelineSet, eventId);
      this.activeTimeline = eventTimeline;
      await this._reset(eventId);
      return true;
    } catch {
      return false;
    }
  }

  async paginateTimeline(backwards = false, limit = 30) {
    if (this.initialized === false) return false;
    if (this.isOngoingPagination) return false;

    this.isOngoingPagination = true;

    const timelineToPaginate = backwards
      ? getFirstLinkedTimeline(this.activeTimeline)
      : getLastLinkedTimeline(this.activeTimeline);

    if (timelineToPaginate.getPaginationToken(backwards ? 'b' : 'f') === null) {
      this.isOngoingPagination = false;
      this.emit(cons.events.roomTimeline.PAGINATED, backwards, 0, false);
      return false;
    }

    const oldSize = this.timeline.length;
    try {
      const canPaginateMore = await this.matrixClient
        .paginateEventTimeline(timelineToPaginate, { backwards, limit });

      if (this.isEncrypted()) await this.decryptAllEventsOfTimeline(this.activeTimeline);
      this._populateTimelines();

      const loaded = this.timeline.length - oldSize;
      this.isOngoingPagination = false;
      this.emit(cons.events.roomTimeline.PAGINATED, backwards, loaded, canPaginateMore);
      return true;
    } catch {
      this.isOngoingPagination = false;
      this.emit(cons.events.roomTimeline.PAGINATED, backwards, 0, true);
      return false;
    }
  }

  decryptAllEventsOfTimeline(eventTimeline) {
    const decryptionPromises = eventTimeline
      .getEvents()
      .filter((event) => event.isEncrypted() && !event.clearEvent)
      .reverse()
      .map((event) => event.attemptDecryption(this.matrixClient.crypto, { isRetry: true }));

    return Promise.allSettled(decryptionPromises);
  }

  markAsRead() {
    const readEventId = this.getReadUpToEventId();
    if (this.timeline.length === 0) return;
    const latestEvent = this.timeline[this.timeline.length - 1];
    if (readEventId === latestEvent.getId()) return;
    this.matrixClient.sendReadReceipt(latestEvent);
  }

  hasEventInLiveTimeline(eventId) {
    const timelineSet = this.getUnfilteredTimelineSet();
    return timelineSet.getTimelineForEvent(eventId) === this.liveTimeline;
  }

  hasEventInActiveTimeline(eventId) {
    const timelineSet = this.getUnfilteredTimelineSet();
    return timelineSet.getTimelineForEvent(eventId) === this.activeTimeline;
  }

  getUnfilteredTimelineSet() {
    return this.room.getUnfilteredTimelineSet();
  }

  getLiveReaders() {
    const lastEvent = this.timeline[this.timeline.length - 1];
    const liveEvents = this.liveTimeline.getEvents();
    const lastLiveEvent = liveEvents[liveEvents.length - 1];

    let readers = [];
    if (lastEvent) readers = this.room.getUsersReadUpTo(lastEvent);
    if (lastLiveEvent !== lastEvent) {
      readers.splice(readers.length, 0, ...this.room.getUsersReadUpTo(lastLiveEvent));
    }
    return [...new Set(readers)];
  }

  getEventReaders(eventId) {
    const readers = [];
    let eventIndex = this.getEventIndex(eventId);
    if (eventIndex < 0) return this.getLiveReaders();
    for (; eventIndex < this.timeline.length; eventIndex += 1) {
      readers.splice(readers.length, 0, ...this.room.getUsersReadUpTo(this.timeline[eventIndex]));
    }
    return [...new Set(readers)];
  }

  getReadUpToEventId() {
    return this.room.getEventReadUpTo(this.matrixClient.getUserId());
  }

  getEventIndex(eventId) {
    return this.timeline.findIndex((mEvent) => mEvent.getId() === eventId);
  }

  findEventByIdInTimelineSet(eventId, eventTimelineSet = this.getUnfilteredTimelineSet()) {
    return eventTimelineSet.findEventById(eventId);
  }

  findEventById(eventId) {
    return this.timeline[this.getEventIndex(eventId)] ?? null;
  }

  deleteFromTimeline(eventId) {
    const i = this.getEventIndex(eventId);
    if (i === -1) return undefined;
    return this.timeline.splice(i, 1);
  }

  _listenEvents() {
    this._listenRoomTimeline = (event, room, toStartOfTimeline, removed, data) => {
      if (room.roomId !== this.roomId) return;
      if (this.isOngoingPagination) return;

      // User is currently viewing the old events probably
      // no need to add this event and emit changes.
      if (this.isServingLiveTimeline() === false) return;

      // We only process live events here
      if (!data.liveEvent) return;

      if (event.isEncrypted()) {
        // We will add this event after it is being decrypted.
        this.ongoingDecryptionCount += 1;
        return;
      }

      // FIXME: An unencrypted plain event can come
      // while previous event is still decrypting
      // and has not been added to timeline
      // causing unordered timeline view.

      this.addToTimeline(event);
      this.emit(cons.events.roomTimeline.EVENT, event);
    };

    this._listenDecryptEvent = (event) => {
      if (event.getRoomId() !== this.roomId) return;
      if (this.isOngoingPagination) return;

      // Not a live event.
      // so we don't need to process it here
      if (this.ongoingDecryptionCount === 0) return;

      if (this.ongoingDecryptionCount > 0) {
        this.ongoingDecryptionCount -= 1;
      }
      this.addToTimeline(event);
      this.emit(cons.events.roomTimeline.EVENT, event);
    };

    this._listenRedaction = (event, room) => {
      if (room.roomId !== this.roomId) return;
      this.deleteFromTimeline(event.getId());
      this.editedTimeline.delete(event.getId());
      this.reactionTimeline.delete(event.getId());
      this.emit(cons.events.roomTimeline.EVENT);
    };

    this._listenTypingEvent = (event, member) => {
      if (member.roomId !== this.roomId) return;

      const isTyping = member.typing;
      if (isTyping) this.typingMembers.add(member.userId);
      else this.typingMembers.delete(member.userId);
      this.emit(cons.events.roomTimeline.TYPING_MEMBERS_UPDATED, new Set([...this.typingMembers]));
    };
    this._listenReciptEvent = (event, room) => {
      // we only process receipt for latest message here.
      if (room.roomId !== this.roomId) return;
      const receiptContent = event.getContent();

      const mEvents = this.liveTimeline.getEvents();
      const lastMEvent = mEvents[mEvents.length - 1];
      const lastEventId = lastMEvent.getId();
      const lastEventRecipt = receiptContent[lastEventId];

      if (typeof lastEventRecipt === 'undefined') return;
      if (lastEventRecipt['m.read']) {
        this.emit(cons.events.roomTimeline.LIVE_RECEIPT);
      }
    };

    this.matrixClient.on('Room.timeline', this._listenRoomTimeline);
    this.matrixClient.on('Room.redaction', this._listenRedaction);
    this.matrixClient.on('Event.decrypted', this._listenDecryptEvent);
    this.matrixClient.on('RoomMember.typing', this._listenTypingEvent);
    this.matrixClient.on('Room.receipt', this._listenReciptEvent);
  }

  removeInternalListeners() {
    if (!this.initialized) return;
    this.matrixClient.removeListener('Room.timeline', this._listenRoomTimeline);
    this.matrixClient.removeListener('Room.redaction', this._listenRedaction);
    this.matrixClient.removeListener('Event.decrypted', this._listenDecryptEvent);
    this.matrixClient.removeListener('RoomMember.typing', this._listenTypingEvent);
    this.matrixClient.removeListener('Room.receipt', this._listenReciptEvent);
  }
}

export default RoomTimeline;
