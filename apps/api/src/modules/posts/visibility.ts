/**
 * SQL predicate: may the viewer (bound as $1) see post `p`?
 *
 * - authors always see their own posts
 * - blocks in either direction hide everything
 * - friends see public + friends posts, and close_friends posts if they are on the author's list
 * - everyone else sees public posts, unless the author's account is private
 */
export const POST_VISIBLE_TO_VIEWER = `(
  p.author_id = $1
  OR (
    NOT EXISTS (
      SELECT 1 FROM blocks b
       WHERE (b.blocker_id = $1 AND b.blocked_id = p.author_id)
          OR (b.blocker_id = p.author_id AND b.blocked_id = $1)
    )
    AND (
      (
        EXISTS (SELECT 1 FROM friendships f
                 WHERE f.user_a = LEAST($1::uuid, p.author_id) AND f.user_b = GREATEST($1::uuid, p.author_id))
        AND (
          p.audience IN ('public', 'friends')
          OR EXISTS (SELECT 1 FROM close_friends cf WHERE cf.owner_id = p.author_id AND cf.friend_id = $1)
        )
      )
      OR (
        p.audience = 'public'
        AND NOT EXISTS (SELECT 1 FROM users au WHERE au.id = p.author_id AND au.is_private)
      )
    )
  )
)`;
