from playwright.sync_api import sync_playwright
import time
import subprocess

def run_verification():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # Emulate a mobile device
        context = browser.new_context(
            user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1',
            viewport={'width': 375, 'height': 667},
            is_mobile=True,
            has_touch=True
        )
        page = context.new_page()

        process = subprocess.Popen(['python3', '-m', 'http.server', '8084'])
        time.sleep(2)

        try:
            page.goto("http://localhost:8084/index.html")
            page.wait_for_selector("#btn-play", state="visible")
            page.click("#btn-play")

            page.wait_for_selector("#screen-round", state="visible", timeout=30000)
            time.sleep(2)

            # Check if is-mobile class is applied
            is_mobile_class = page.evaluate("() => document.body.classList.contains('is-mobile')")
            print(f"Is mobile class present: {is_mobile_class}")

            # Check the order of elements
            # round-header should be top, then search-container, then reader-container
            elements_top = page.evaluate("""
                () => {
                    const header = document.querySelector('.round-header').getBoundingClientRect().top;
                    const search = document.querySelector('.search-container').getBoundingClientRect().top;
                    const reader = document.querySelector('.reader-container').getBoundingClientRect().top;
                    return { header, search, reader };
                }
            """)
            print(f"Elements top positions: {elements_top}")

            if elements_top['header'] < elements_top['search'] < elements_top['reader']:
                print("SUCCESS: Search container is between header and reader")
            else:
                print("FAILURE: Search container is NOT in the correct position")

            page.screenshot(path="verification/mobile_layout.png")

        finally:
            process.terminate()
            browser.close()

if __name__ == "__main__":
    run_verification()
