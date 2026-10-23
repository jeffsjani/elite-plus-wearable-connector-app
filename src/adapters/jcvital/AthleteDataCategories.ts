export const ATHLETE_SOURCE_LABELS = {
  heart: 'Heart',
  bloodOxygen: 'Blood Oxygen',
  temperature: 'Temperature',
  activity: 'Activity',
  sleep: 'Sleep',
  workouts: 'Workouts',
} as const

export const athleteVisibleDataCategories = [...new Set(Object.values(ATHLETE_SOURCE_LABELS))]
