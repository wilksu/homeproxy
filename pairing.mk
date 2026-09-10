# SPDX-License-Identifier: GPL-2.0-only
# Recipes may live under the same checkout at packages/*.
HP_PAIRING_ROOT:=$(realpath $(dir $(lastword $(MAKEFILE_LIST))))
$(foreach line,$(shell python3 $(HP_PAIRING_ROOT)/scripts/pairing.py),$(eval $(line)))
