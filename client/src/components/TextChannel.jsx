import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Hash, Trash, Users } from 'lucide-react';
import { emitAck } from '../api.js';
import Avatar from './Avatar.jsx';

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif)(\?\S*)?$/i;
const GROUP_GAP = 7 * 60_000;

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

function formatWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return `Hoje às ${timeFmt.format(d)}`;
  if (d.toDateString() === yesterday.toDateString()) return `Ontem às ${timeFmt.format(d)}`;
  return `${d.toLocaleDateString('pt-BR')} ${timeFmt.format(d)}`;
}

function MessageContent({ content }) {
  const parts = content.split(URL_RE);
  const images = content.match(URL_RE)?.filter((u) => IMAGE_RE.test(u)) || [];
  return (
    <>
      <div className="message-text">
        {parts.map((part, i) =>
          i % 2 === 1 ? (
            <a key={i} href={part} target="_blank" rel="noreferrer">
              {part}
            </a>
          ) : (
            <Fragment key={i}>{part}</Fragment>
          ),
        )}
      </div>
      {images.map((src) => (
        <a key={src} href={src} target="_blank" rel="noreferrer">
          <img className="message-image" src={src} alt="" loading="lazy" />
        </a>
      ))}
    </>
  );
}

export default function TextChannel({ channel, socket, me, users, cache, setMessages, typing, notify, showMembers, onToggleMembers }) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const prevHeight = useRef(null);
  const stickToBottom = useRef(true);
  const lastTyping = useRef(0);

  const items = cache?.items || [];

  async function load(before) {
    if (loading) return;
    setLoading(true);
    try {
      const res = await emitAck(socket, 'messages:fetch', { channelId: channel.id, before });
      if (before) prevHeight.current = listRef.current?.scrollHeight ?? null;
      setMessages((prev) => {
        const current = prev[channel.id]?.items || [];
        const merged = before ? [...res.messages, ...current] : res.messages;
        return { ...prev, [channel.id]: { items: merged, hasMore: res.hasMore, loaded: true } };
      });
    } catch (err) {
      notify(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!cache?.loaded && socket) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, cache?.loaded, socket]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [channel.id]);

  // Mantém a posição ao carregar mensagens antigas; desce até o fim em mensagens novas.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (prevHeight.current != null) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items]);

  const onScroll = () => {
    const el = listRef.current;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && cache?.hasMore && !loading && items.length) load(items[0].id);
  };

  async function send() {
    const content = text.trim();
    if (!content) return;
    setText('');
    stickToBottom.current = true;
    try {
      await emitAck(socket, 'message:send', { channelId: channel.id, content });
    } catch (err) {
      setText(content);
      notify(err.message);
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onChange = (e) => {
    setText(e.target.value);
    if (Date.now() - lastTyping.current > 2500) {
      lastTyping.current = Date.now();
      socket.emit('typing', { channelId: channel.id });
    }
  };

  const remove = async (id) => {
    try {
      await emitAck(socket, 'message:delete', { id });
    } catch (err) {
      notify(err.message);
    }
  };

  const typers = Object.keys(typing)
    .filter((k) => k.startsWith(`${channel.id}:`))
    .map((k) => users[k.split(':')[1]]?.displayName)
    .filter(Boolean);

  return (
    <div className="text-channel">
      <header className="main-header">
        <Hash size={22} className="muted" />
        <span className="title">{channel.name}</span>
        <div className="spacer" />
        <button className={`icon-btn${showMembers ? ' on' : ''}`} title="Membros" onClick={onToggleMembers}>
          <Users size={20} />
        </button>
      </header>

      <div className="messages" ref={listRef} onScroll={onScroll}>
        {cache?.loaded && !cache.hasMore && (
          <div className="channel-intro">
            <div className="channel-intro-icon">
              <Hash size={40} />
            </div>
            <h2>Boas-vindas a #{channel.name}!</h2>
            <p className="muted">Este é o começo da sala #{channel.name}.</p>
          </div>
        )}
        {loading && <div className="loading-more">Carregando…</div>}
        {items.map((m, i) => {
          const prev = items[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const grouped = !newDay && prev.userId === m.userId && m.createdAt - prev.createdAt < GROUP_GAP;
          const author = users[m.userId];
          const canDelete = m.userId === me.id || me.isAdmin;
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="day-divider">
                  <span>{dayFmt.format(new Date(m.createdAt))}</span>
                </div>
              )}
              <div className={`message${grouped ? ' grouped' : ''}`}>
                {grouped ? (
                  <span className="message-time-side">{timeFmt.format(new Date(m.createdAt))}</span>
                ) : (
                  <Avatar user={author} size={40} />
                )}
                <div className="message-body">
                  {!grouped && (
                    <div className="message-header">
                      <span className="message-author" style={{ color: author?.color }}>
                        {author?.displayName || 'Usuário removido'}
                      </span>
                      <span className="message-time">{formatWhen(m.createdAt)}</span>
                    </div>
                  )}
                  <MessageContent content={m.content} />
                </div>
                {canDelete && (
                  <button className="message-delete" title="Apagar mensagem" onClick={() => remove(m.id)}>
                    <Trash size={16} />
                  </button>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>

      <div className="composer">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={`Conversar em #${channel.name}`}
          maxLength={4000}
        />
      </div>
      <div className="typing">
        {typers.length > 0 && (
          <>
            <span className="typing-dots">
              <i />
              <i />
              <i />
            </span>
            <b>{typers.join(', ')}</b> {typers.length > 1 ? 'estão digitando…' : 'está digitando…'}
          </>
        )}
      </div>
    </div>
  );
}
