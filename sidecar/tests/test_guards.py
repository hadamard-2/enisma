import pytest

from guards import ESPEAK_PATH_LIMIT, assert_espeak_data_path, assert_no_digits


def test_a_short_espeak_path_is_accepted():
    assert_espeak_data_path("/opt/enisma/espeak-ng-data")


def test_the_longest_accepted_path_is_159_characters():
    path = "/a" + "b" * (ESPEAK_PATH_LIMIT - 2)
    assert len(path) == 159
    assert_espeak_data_path(path)


def test_a_160_character_path_is_rejected_before_espeak_can_kill_us():
    path = "/a" + "b" * (ESPEAK_PATH_LIMIT - 1)
    assert len(path) == 160
    with pytest.raises(RuntimeError) as exc:
        assert_espeak_data_path(path)
    assert "159" in str(exc.value)


def test_expanded_text_without_digits_passes():
    assert_no_digits("ሦስት መቶ", "am")


def test_expanded_text_still_holding_digits_is_rejected():
    with pytest.raises(RuntimeError) as exc:
        assert_no_digits("1000000000", "ti")
    assert "ti" in str(exc.value)
