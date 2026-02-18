from poker_bot import BotController


if __name__ == "__main__":
    bot = BotController(
        config_path="config/calibration.json",
        rank_templates="templates/ranks",
        suit_templates="templates/suits",
    )
    bot.run(use_overlay=True, interval_s=0.6)
