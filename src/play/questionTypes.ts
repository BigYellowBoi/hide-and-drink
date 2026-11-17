import type { SupabaseClient } from '@supabase/supabase-js'

export interface QuestionOption {
  id: string
  label?: string
  /** Fixed distance; null for a "custom" option where the seeker types one. */
  distance_m?: number | null
  [key: string]: unknown
}

export interface QuestionType {
  type: string
  prompt: string
  reward_draw: number
  reward_pick: number
  auto_shading: boolean
  options: QuestionOption[]
  extra: Record<string, unknown>
}

const cache = new Map<string, Promise<QuestionType[]>>()

/** The city's question types (content data, readable by every player), once per session. */
export function loadQuestionTypes(client: SupabaseClient, city: string): Promise<QuestionType[]> {
  let p = cache.get(city)
  if (!p) {
    p = (async () => {
      const { data, error } = await client
        .from('question_types')
        .select('type, prompt, reward_draw, reward_pick, auto_shading, options, extra')
        .eq('city', city)
        .order('sort')
      if (error) throw new Error(error.message)
      return (data ?? []) as QuestionType[]
    })()
    cache.set(city, p)
    p.catch(() => cache.delete(city))
  }
  return p
}

export const optionLabel = (o: QuestionOption) =>
  o.label ??
  (typeof o.distance_m === 'number'
    ? o.distance_m >= 1000
      ? `${o.distance_m / 1000} km`
      : `${o.distance_m} m`
    : o.id === 'custom'
      ? 'Custom'
      : o.id)
