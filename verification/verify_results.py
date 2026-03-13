
import asyncio
from playwright.async_api import async_playwright

async def verify_results():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        # Load the game
        await page.goto("http://localhost:8000/index.html")
        await page.wait_for_function("window.showResultsScreen !== undefined", timeout=20000)

        # Force promoActive to true and set a win streak
        await page.evaluate("""() => {
            setPromoActive(true);
            playerStats.winStreakCurrent = 5;
            updatePromoDisplay();
            updateStatsDisplay();

            // Mock a result
            const result = {
                type: 'book',
                baseScore: 100,
                roundScore: 150,
                multiplier: 1.5,
                streak: 5,
                hadStreakBroken: false,
                book: { title: 'Test Book', author_id: 1 }
            };
            showResultsScreen(result);
        }""")

        # Take screenshot of results screen
        await page.screenshot(path="/app/verification/results_promo.png")

        # Check answer screen too
        await page.evaluate("""() => {
            const book = { title: 'Test Book', author_id: 1, publication_year: 1900, file: '1.fb2' };
            showAnswerScreen(book);
        }""")
        await page.screenshot(path="/app/verification/answer_promo.png")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(verify_results())
