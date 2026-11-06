"""Corbeille : liste, restauration, suppression définitive."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..services import trash

router = APIRouter(prefix="/api/trash", tags=["trash"])


@router.get("")
def list_trash():
    return trash.listing()


@router.post("/{trash_id}/restore")
def restore(trash_id: int):
    r = trash.restore(trash_id)
    if not r:
        raise HTTPException(404, "not_found")
    return r


@router.delete("/{trash_id}")
def purge(trash_id: int):
    if not trash.purge(trash_id):
        raise HTTPException(404, "not_found")
    return {"purged": trash_id}


@router.delete("")
def empty():
    return {"purged": trash.empty()}
