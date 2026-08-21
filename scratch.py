import asyncio
from bot.pg_db import create_client

async def main():
    db = create_client()
    try:
        # Test 1: plain unnest
        rs = await db.execute("SELECT t.name FROM unnest(?) AS t(name)", [["A", "B", "c"]])
        print("Test 1:", [r[0] for r in rs.rows])
    except Exception as e:
        print("Test 1 failed:", e)

    try:
        # Test 2: unnest with cast
        rs = await db.execute("SELECT t.name FROM unnest(?::text[]) AS t(name)", [["A", "B", "c"]])
        print("Test 2:", [r[0] for r in rs.rows])
    except Exception as e:
        print("Test 2 failed:", e)

    try:
        # Test 3: cast as text[]
        rs = await db.execute("SELECT t.name FROM unnest(cast(? as text[])) AS t(name)", [["A", "B", "c"]])
        print("Test 3:", [r[0] for r in rs.rows])
    except Exception as e:
        print("Test 3 failed:", e)
        
    await db.close()

if __name__ == "__main__":
    asyncio.run(main())
