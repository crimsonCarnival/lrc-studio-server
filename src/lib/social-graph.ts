import { Graph } from '@crimson-carnival/ds-js'
import Follow from '../db/follow.model.js'

export const socialGraph = new Graph<string>(true) // directed

export async function initSocialGraph(): Promise<void> {
  if (socialGraph.vertexCount > 0) return  // already loaded
  const follows = await Follow.find({}, 'followerId followingId').lean()
  for (const f of follows) {
    socialGraph.addEdge(f.followerId.toString(), f.followingId.toString())
  }
}
