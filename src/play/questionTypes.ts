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

/** The type's colour (as in the original game), from question_types.extra.colour. */
export function typeColour(types: readonly QuestionType[] | null, type: string): string | null {
  const c = types?.find((t) => t.type === type)?.extra?.colour
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null
}

/** Dark or light text for a filled tile of colour hex (WCAG relative luminance). */
export function textOn(hex: string): '#17222E' | '#FFFFFF' {
  const lin = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const l = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5)
  // Contrast against white vs against --bg (#17222E, luminance ~0.015).
  return (1.05 / (l + 0.05)) >= (l + 0.05) / 0.065 ? '#FFFFFF' : '#17222E'
}
