-- Seed a synthetic dataset to measure the feed query. All rows use the phone prefix +999 for cleanup.
\timing on
BEGIN;

INSERT INTO users (phone, username, display_name)
SELECT '+999' || lpad(g::text, 9, '0'), 'perf_' || g, 'Perf ' || g
FROM generate_series(1, 5000) g;

CREATE TEMP TABLE pu AS
SELECT id, row_number() OVER (ORDER BY phone) AS rn FROM users WHERE phone LIKE '+999%';

-- perf user #1 has 40 friends.
INSERT INTO friendships (user_a, user_b)
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id)
FROM pu a JOIN pu b ON a.rn = 1 AND b.rn BETWEEN 2 AND 41
ON CONFLICT DO NOTHING;

-- Everyone else gets a handful of random friendships.
INSERT INTO friendships (user_a, user_b)
SELECT DISTINCT LEAST(x.id, y.id), GREATEST(x.id, y.id)
FROM pu x
CROSS JOIN generate_series(1, 5) k
JOIN pu y ON y.rn = ((x.rn * 7919 + k * 104729) % 5000) + 1 AND y.id <> x.id
ON CONFLICT DO NOTHING;

-- 300k posts spread across all perf users, mixed audiences, newest first by seq.
INSERT INTO posts (author_id, caption, audience, created_at)
SELECT pu.id, 'perf post ' || g,
       (ARRAY['friends','friends','friends','public','close_friends'])[1 + (g % 5)],
       now() - (g || ' seconds')::interval
FROM generate_series(1, 300000) g
JOIN pu ON pu.rn = (g * 31 % 5000) + 1;

COMMIT;
ANALYZE posts;
ANALYZE friendships;
SELECT count(*) AS perf_users FROM users WHERE phone LIKE '+999%';
SELECT count(*) AS perf_posts FROM posts WHERE caption LIKE 'perf post %';
SELECT count(*) AS perf_friendships FROM friendships f JOIN users u ON u.id = f.user_a WHERE u.phone LIKE '+999%';
