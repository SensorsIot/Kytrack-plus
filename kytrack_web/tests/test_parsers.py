from kytrack_web.parsers import aprs_coord_to_decimal, parse_aprs_line


def test_aprs_coord_to_decimal():
    assert round(aprs_coord_to_decimal("4706.08", "N"), 6) == 47.101333
    assert round(aprs_coord_to_decimal("00721.87", "E"), 6) == 7.3645


def test_parse_sonde_object_packet():
    line = (
        "HB9BLA-14>APLWS2,qAU,HB9BLA-15:"
        ";W4150594 *123415h4706.08N/00721.87EO099/012/A=089396!"
        "w?S!Clb=3.4m/s t=-49.9C h=3.2% 404.50MHz Type=RS41-SG"
    )
    point = parse_aprs_line(line)
    assert point is not None
    assert point.id == "W4150594"
    assert round(point.lat, 6) == 47.101333
    assert round(point.lon, 6) == 7.3645
    assert round(point.alt_m) == 27248
    assert point.climb_mps == 3.4
    assert point.course_deg == 99
    assert round(point.speed_mps, 2) == 6.17
    assert point.meta["type"] == "RS41-SG"
    assert point.meta["frequency_mhz"] == 404.5


def test_parse_receiver_position_packet():
    line = (
        "HB9BLA-15>APNL51,TCPIP*,qAI,HB9BLA-15:"
        "!4728.43N/00745.56E`Radiosonde Tracker - Based on kxyTrack"
    )
    point = parse_aprs_line(line)
    assert point is not None
    assert point.id == "HB9BLA-15"
    assert point.source == "receiver"
