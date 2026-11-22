import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useActions } from '../lib/store'
import { IconSpeaker } from './Icons'

type Phase = 'idle' | 'preparing' | 'playing' | 'error'

/**
 * Reads the current note out loud.
 *
 * Piper runs locally and writes a WAV file; the audio is loaded into the page
 * and played from there, so nothing leaves the machine.
 *
 * The text is normally the rendered note, which already reads as prose. When
 * it is raw Markdown instead, the core cleans the syntax up first.
 */
export function ReadAloud({ text, plain = false }: { text: string; plain?: boolean }) {
  const actions = useActions()
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const stop = useCallback(() => {
    api.stopSpeaking()
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.currentTime = 0
    }
    setPhase('idle')
  }, [])

  // Release the audio when the component goes away.
  useEffect(() => {
    return () => {
      api.stopSpeaking()
      audioRef.current?.pause()
    }
  }, [])

  const read = useCallback(async () => {
    if (phase === 'preparing') return
    if (phase === 'playing') {
      stop()
      return
    }

    const trimmed = text.trim()
    if (!trimmed) {
      actions.toast('warn', 'There is nothing to read')
      return
    }

    let model = ''
    let piper = ''
    let rate = 1.0
    try {
      model = api.getSetting('ttsVoice') ?? ''
      piper = api.getSetting('ttsPiperPath') ?? ''
      const storedRate = Number(api.getSetting('ttsRate') ?? '1')
      if (Number.isFinite(storedRate) && storedRate > 0) rate = storedRate
    } catch {
      /* settings are best-effort */
    }

    if (!model) {
      const status = api.ttsStatus()
      if (!status.available) {
        actions.toast('error', status.error ?? 'Speech is not set up on this machine')
        return
      }
      const first = status.voices[0]
      if (!first) {
        actions.toast('error', 'No Piper voice models were found')
        return
      }
      model = first.path
      actions.toast('info', `Using the voice “${first.name}”. Choose another in Settings.`)
    }

    setPhase('preparing')
    setMessage('Preparing the audio…')
    try {
      const path = await api.speak(trimmed, model, piper || undefined, rate, plain)
      const url = window.delta.audioFileUrl(path)
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => {
        setPhase('idle')
        setMessage('')
      }
      audio.onerror = () => {
        setPhase('error')
        setMessage('The audio could not be played')
      }
      await audio.play()
      setPhase('playing')
      setMessage('Reading…')
    } catch (error) {
      setPhase('error')
      setMessage(String(error))
      actions.toast('error', `Could not read the note: ${String(error)}`)
    }
  }, [actions, phase, plain, stop, text])

  return (
    <>
      <button
        type="button"
        className={`btn${phase === 'playing' ? ' active' : ''}`}
        onClick={() => void read()}
        disabled={phase === 'preparing'}
        title={phase === 'playing' ? 'Stop reading' : 'Read the note aloud'}
      >
        <IconSpeaker />
        {phase === 'preparing' ? 'Preparing…' : phase === 'playing' ? 'Stop' : 'Read aloud'}
      </button>
      {message && phase !== 'idle' && <span className="sr-only">{message}</span>}
    </>
  )
}
