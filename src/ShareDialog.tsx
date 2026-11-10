import { Dialog } from "@base-ui/react/dialog";
import {
  Check,
  Copy,
  LoaderCircle,
  LogOut,
  Radio,
  Save,
  X,
} from "lucide-react";
import { useState, type ReactElement } from "react";
import { toast } from "sonner";
import {
  closeProject,
  displayName,
  joinSession,
  saveCopy,
  setDisplayName,
  startSharing,
  stopSharing,
} from "./actions";
import { useStore } from "./store";
import { plural } from "./ui";

export function ShareDialog({ children }: { children: ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={children} />
      <Dialog.Portal>
        <Dialog.Backdrop className='dialog-backdrop' />
        <Dialog.Popup className='dialog'>
          <div className='dialog-header'>
            <Dialog.Title className='dialog-title'>Live sharing</Dialog.Title>
            <Dialog.Close className='btn btn-ghost icon-btn' aria-label='Close'>
              <X />
            </Dialog.Close>
          </div>
          <ShareContent close={() => setOpen(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ShareContent({ close }: { close: () => void }) {
  const share = useStore((state) => state.share);
  const isHost = useStore((state) => state.project?.isHost ?? false);
  const hasProject = useStore((state) => state.project !== null);
  const routes = useStore((state) => state.routes);
  const peers = useStore((state) => state.peers.length);

  switch (share.role) {
    case "starting":
      return (
        <Busy
          text='Starting the session'
          detail='Reaching a relay so people on other networks can connect.'
        />
      );
    case "joining":
      return (
        <Busy
          text='Connecting to the host'
          detail='This usually takes a few seconds.'
        />
      );
    case "host":
      return (
        <>
          <NameField />
          <p className='dialog-text'>
            Send this ticket to the people you want to write with. Anyone who
            has it can edit this project until you stop sharing.
          </p>
          <Ticket ticket={share.ticket} />
          <p className='dialog-note'>
            The ticket contains your IP addresses. Only share it with people you
            trust.
          </p>
          <div className='dialog-footer'>
            <span className='dialog-status'>
              <span className='live-dot' />
              {peers
                ? `${plural(peers, "person")} connected`
                : "Waiting for people to join"}
              {routeSummary(Object.values(routes))}
            </span>
            <button
              className='btn btn-danger'
              onClick={() => void stopSharing()}
            >
              Stop sharing
            </button>
          </div>
        </>
      );
    case "guest":
      return (
        <>
          <NameField />
          <div className='dialog-footer'>
            <span className='dialog-status'>
              <span className='live-dot' />
              {routes[1] === "direct"
                ? "Connected directly to the host"
                : "Connected to the host through a relay"}
            </span>
            <button className='btn' onClick={() => void stopSharing()}>
              <LogOut /> Leave
            </button>
          </div>
        </>
      );
    case "ended":
      return (
        <>
          <p className='dialog-text'>
            This session has ended. You're editing an offline copy that
            disappears when you close it.
          </p>
          <div className='dialog-footer end'>
            <button
              className='btn'
              onClick={() => void closeProject().then(close)}
            >
              Close project
            </button>
            <button className='btn btn-primary' onClick={() => void saveCopy()}>
              <Save /> Save a copy
            </button>
          </div>
        </>
      );
    case "off":
      return (
        <>
          <NameField />
          {isHost && (
            <section className='dialog-section'>
              <h3>Share this project</h3>
              <p className='dialog-text'>
                People you invite edit with you in real time. Connections are
                peer to peer and encrypted, nothing is uploaded. A public relay
                only forwards encrypted traffic when a direct connection isn't
                possible.
              </p>
              <button
                className='btn btn-primary'
                onClick={() => void startSharing()}
              >
                <Radio /> Start sharing
              </button>
            </section>
          )}
          <JoinForm hasProject={hasProject} close={close} />
        </>
      );
  }
}

function NameField() {
  return (
    <label className='field'>
      <span>Your name</span>
      <input
        defaultValue={displayName()}
        maxLength={40}
        spellCheck={false}
        onBlur={(event) => setDisplayName(event.target.value)}
      />
    </label>
  );
}

function JoinForm({
  hasProject,
  close,
}: {
  hasProject: boolean;
  close: () => void;
}) {
  const [ticket, setTicket] = useState("");
  return (
    <section className='dialog-section'>
      <h3>Join a session</h3>
      <form
        className='join-form'
        onSubmit={(event) => {
          event.preventDefault();
          close();
          void joinSession(ticket);
        }}
      >
        <input
          className='mono'
          placeholder='Paste a ticket'
          spellCheck={false}
          value={ticket}
          onChange={(event) => setTicket(event.target.value)}
        />
        <button className='btn' disabled={!ticket.trim()}>
          Join
        </button>
      </form>
      {hasProject && (
        <p className='dialog-note'>Joining closes the project you have open.</p>
      )}
    </section>
  );
}

function Ticket({ ticket }: { ticket: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ticket);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy the ticket", {
        description: "Select it and copy it manually.",
      });
    }
  };
  return (
    <div className='ticket'>
      <input
        className='mono'
        readOnly
        value={ticket}
        onFocus={(event) => event.target.select()}
      />
      <button className='btn' onClick={() => void copy()}>
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Busy({ text, detail }: { text: string; detail: string }) {
  return (
    <div className='busy'>
      <LoaderCircle className='spin' />
      <div>
        <div>{text}</div>
        <div className='dialog-note'>{detail}</div>
      </div>
    </div>
  );
}

function routeSummary(routes: string[]) {
  if (routes.length === 0) return null;
  const direct = routes.filter((route) => route === "direct").length;
  if (direct === routes.length) return ", all direct";
  if (direct === 0) return ", through a relay";
  return `, ${direct} direct, ${routes.length - direct} through a relay`;
}
