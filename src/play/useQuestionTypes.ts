import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { loadQuestionTypes, type QuestionType } from './questionTypes'

/** The city's question types (cached per session); null while loading or without a backend. */
export function useQuestionTypes(city: string): QuestionType[] | null {
  const [types, setTypes] = useState<QuestionType[] | null>(null)
  useEffect(() => {
    if (!supabase) return
    let live = true
    loadQuestionTypes(supabase, city)
      .then((t) => live && setTypes(t))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [city])
  return types
}
