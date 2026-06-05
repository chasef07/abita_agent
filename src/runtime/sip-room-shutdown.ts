type SipParticipant = {
  identity?: string;
};

type RoomLike = {
  remoteParticipants?: Map<string, SipParticipant>;
  on(
    event: "participantDisconnected",
    listener: (participant: SipParticipant) => void,
  ): unknown;
};

type ShutdownContext = {
  room: RoomLike;
  shutdown(reason?: string): void;
};

type LoggerLike = Pick<Console, "log">;

export function attachSipParticipantShutdown(
  ctx: ShutdownContext,
  participant: SipParticipant,
  options: {
    isTransferred?: () => boolean;
    logger?: LoggerLike;
  } = {},
) {
  const participantIdentity = participant.identity;
  const logger = options.logger ?? console;
  let shutdownRequested = false;

  const requestShutdown = () => {
    if (shutdownRequested || !participantIdentity) return;
    shutdownRequested = true;

    const transferred = (() => {
      try {
        return options.isTransferred?.() ?? false;
      } catch {
        return false;
      }
    })();

    logger.log(
      `[call] SIP participant ${participantIdentity} disconnected (transferred=${transferred}), shutting down job`,
    );
    ctx.shutdown(`sip participant disconnected: ${participantIdentity}`);
  };

  ctx.room.on("participantDisconnected", (p) => {
    if (p.identity === participantIdentity) requestShutdown();
  });

  if (
    participantIdentity &&
    ctx.room.remoteParticipants &&
    !ctx.room.remoteParticipants.has(participantIdentity)
  ) {
    requestShutdown();
  }
}
