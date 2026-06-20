import { Kind, GraphQLError } from 'graphql';
import type {
  ValidationContext,
  ASTVisitor,
  OperationDefinitionNode,
  FragmentDefinitionNode,
  SelectionSetNode,
} from 'graphql';

/**
 * A self-contained query-depth-limiting validation rule (no external dependency).
 *
 * The schema is graph-shaped — Project.user → User.projects → Project.user … —
 * and several entry points (getShare, publicProject, searchProjects) are
 * unauthenticated. Without a depth cap, a deeply nested query amplifies database
 * load and can be used for DoS. This rule rejects any operation whose selection
 * nesting exceeds `maxDepth`, resolving fragment spreads and guarding against
 * cyclic fragments.
 */
export function createDepthLimitRule(maxDepth: number) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments: Record<string, FragmentDefinitionNode> = {};
    for (const def of context.getDocument().definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        fragments[def.name.value] = def;
      }
    }

    function depthOf(
      selectionSet: SelectionSetNode | undefined,
      current: number,
      visited: Set<string>,
    ): number {
      if (!selectionSet) return current;
      let max = current;
      for (const sel of selectionSet.selections) {
        if (sel.kind === Kind.FIELD) {
          if (sel.selectionSet) {
            max = Math.max(max, depthOf(sel.selectionSet, current + 1, visited));
          }
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
          // Inline fragments don't add a level of their own.
          max = Math.max(max, depthOf(sel.selectionSet, current, visited));
        } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
          const name = sel.name.value;
          if (visited.has(name)) continue; // cyclic fragment — stop descending
          const frag = fragments[name];
          if (frag) {
            visited.add(name);
            max = Math.max(max, depthOf(frag.selectionSet, current, visited));
            visited.delete(name);
          }
        }
      }
      return max;
    }

    return {
      OperationDefinition(node: OperationDefinitionNode) {
        const depth = depthOf(node.selectionSet, 0, new Set<string>());
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(`Query exceeds maximum allowed depth of ${maxDepth}`, { nodes: [node] }),
          );
        }
      },
    };
  };
}
